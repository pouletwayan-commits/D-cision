
import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(express.static('public'));
app.use(express.json({ limit: '2mb' }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PORT = process.env.PORT || 3000;

app.post('/api/process', upload.single('audio'), async (req, res) => {
  try {
    const tmp = path.join(process.cwd(), 'tmp_' + Date.now() + '.wav');
    fs.writeFileSync(tmp, req.file.buffer);
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmp),
      model: process.env.TRANSCRIBE_MODEL || 'whisper-1'
    });
    fs.unlinkSync(tmp);
    const transcript = transcription.text;

    const prompt = `Fais un résumé clair et structuré de cette réunion en JSON (points clés, décisions, actions):\n${transcript}`;
    const response = await openai.responses.create({
      model: process.env.SUMMARY_MODEL || 'gpt-4o-mini',
      input: prompt
    });
    const text = response.output_text || "";
    res.json({ transcript, summary: text });
  } catch (e) {
    console.error(e);
    res.status(500).send('Erreur serveur.');
  }
});

app.listen(PORT, () => console.log(`✅ Serveur Décision prêt sur http://localhost:${PORT}`));
