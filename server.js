import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

app.use(express.static('public'));
app.use(express.json({ limit: '2mb' }));

// Timeout long pour uploads audio
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 180000 // 180s
});

const PORT = process.env.PORT || 3000;

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/test-openai', async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(400).json({ ok: false, error: 'OPENAI_API_KEY missing' });
    }
    const resp = await openai.models.list();
    return res.json({ ok: true, models_count: resp.data?.length ?? 0 });
  } catch (err) {
    console.error('OpenAI test error:', err?.message || err);
    return res.status(500).json({
      ok: false,
      name: err?.name,
      message: err?.message,
      type: err?.type,
      code: err?.code
    });
  }
});

// --- utilitaire retry expo pour la transcription ---
async function transcribeWithRetry(tmpPath, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const out = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tmpPath),
        model: process.env.TRANSCRIBE_MODEL || 'whisper-1'
        // Pour tester un autre modèle si besoin :
        // model: process.env.TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe'
      });
      return out.text || '';
    } catch (err) {
      lastErr = err;
      // Si reset réseau → on retente après une petite pause
      const isReset = (err?.code === 'ECONNRESET') || /ECONNRESET|Connection error|fetch/i.test(String(err));
      if (!isReset) break;
      const delay = 1000 * i; // 1s, 2s, 3s...
      console.warn(`Transcribe retry ${i}/${attempts} after reset… waiting ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

app.post('/api/process', upload.single('audio'), async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(400).send('Config manquante: OPENAI_API_KEY');
    if (!req.file) return res.status(400).send('Aucun fichier reçu');

    // Écrit le fichier temporaire avec l’extension d’origine (m4a/mp3/wav)
    const original = req.file.originalname || 'audio.m4a';
    const ext = path.extname(original) || '.m4a';
    const tmp = path.join(process.cwd(), 'tmp_' + Date.now() + ext);
    fs.writeFileSync(tmp, req.file.buffer);

    let transcript = '';
    try {
      transcript = await transcribeWithRetry(tmp, 3);
    } finally {
      fs.unlink(tmp, () => {});
    }

    if (!transcript) return res.status(502).send('Transcription vide');

    const prompt = 'Renvoie UNIQUEMENT du JSON. ' +
      'Champs: key_points[], decisions[], actions[]. Texte: <<< ' + transcript + ' >>>';

    const response = await openai.responses.create({
      model: process.env.SUMMARY_MODEL || 'gpt-4o-mini',
      input: prompt
    });

    const raw = response.output_text || '';
    let summary;
    try {
      const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
      summary = JSON.parse(raw.slice(s, e + 1));
    } catch {
      summary = { key_points: [], decisions: [], actions: [] };
    }

    return res.json({ transcript, summary });
  } catch (err) {
    console.error('Process error:', err);
    return res.status(500).send('Erreur: ' + (err?.message || err));
  }
});

app.listen(PORT, () => console.log(`✅ Décision v2 en ligne sur http://localhost:${PORT}`));
