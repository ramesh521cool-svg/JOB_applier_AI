require("dotenv").config({ path: require("path").join(__dirname, ".env"), override: true });
const express = require("express");
const path    = require("path");
const { v4: uuidv4 } = require("uuid");
const multer  = require("multer");
const cors    = require("cors");

const {
  getProfile, saveProfile, getPrefs, savePrefs,
  getApplications, getApplication, upsertApplication, clearApplications, deleteApplication,
  getSession, createSession, updateSession, getStats,
} = require("./db");
const scraper = require("./scraper");
const ai      = require("./ai");

const app  = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

async function extractText(buffer, mimetype, originalname) {
  const ext = path.extname(originalname).toLowerCase();
  if (ext === ".pdf" || mimetype === "application/pdf") {
    return (await require("pdf-parse")(buffer)).text;
  }
  if (ext === ".docx") {
    return (await require("mammoth").extractRawText({ buffer })).value;
  }
  return buffer.toString("utf-8");
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => res.json({ status: "ok", version: "2.1.0" }));

// ── Profile ───────────────────────────────────────────────────────────────────
app.get("/api/profile", (req, res) => res.json(getProfile()));

app.post("/api/profile", (req, res) => {
  try { const d = req.body; delete d.id; saveProfile(d); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/profile/resume", upload.single("resume"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const text = await extractText(req.file.buffer, req.file.mimetype, req.file.originalname);
    saveProfile({ resume_text: text });
    res.json({ success: true, preview: text.slice(0, 300) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Preferences ───────────────────────────────────────────────────────────────
app.get("/api/preferences", (req, res) => res.json(getPrefs()));

app.post("/api/preferences", (req, res) => {
  try {
    const data = req.body; delete data.id;
    ["job_titles","locations","experience_levels","job_types","keywords","blacklist_companies","blacklist_titles"]
      .forEach(k => { if (Array.isArray(data[k])) data[k] = JSON.stringify(data[k]); });
    savePrefs(data);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Applications ──────────────────────────────────────────────────────────────
app.get("/api/applications", (req, res) => {
  res.json(getApplications(parseInt(req.query.limit) || 200));
});

app.get("/api/applications/:id", (req, res) => {
  const a = getApplication(req.params.id);
  if (!a) return res.status(404).json({ error: "Not found" });
  res.json(a);
});

app.patch("/api/applications/:id", (req, res) => {
  try {
    const existing = getApplication(req.params.id);
    if (!existing) return res.status(404).json({ error: "Not found" });
    upsertApplication({ ...existing, ...req.body });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete a single application
app.delete("/api/applications/:id", (req, res) => {
  try { deleteApplication(req.params.id); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Clear ALL applications
app.delete("/api/applications", (req, res) => {
  try { clearApplications(); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/stats", (req, res) => res.json(getStats()));

// ── SSE stream ────────────────────────────────────────────────────────────────
app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();
  const hb = setInterval(() => { try { res.write(": heartbeat\n\n"); } catch {} }, 20000);
  scraper.addClient(res);
  req.on("close", () => { clearInterval(hb); scraper.removeClient(res); });
});

// ── Session ───────────────────────────────────────────────────────────────────
app.get("/api/session/status", (req, res) => res.json({ running: scraper.isRunning() }));

app.post("/api/session/stop", async (req, res) => {
  await scraper.stopSession(); res.json({ success: true });
});

// ── Search jobs (LinkedIn scrape, no apply) ───────────────────────────────────
app.post("/api/session/search", async (req, res) => {
  if (scraper.isRunning()) return res.status(409).json({ error: "A session is already running" });
  const { linkedinEmail, linkedinPassword } = req.body;
  if (!linkedinEmail || !linkedinPassword) return res.status(400).json({ error: "LinkedIn credentials required" });
  const prefs  = getPrefs();
  const titles = JSON.parse(prefs.job_titles || "[]");
  if (!titles.length) return res.status(400).json({ error: "Add job titles to your preferences first" });
  const sessionId = uuidv4();
  createSession(sessionId);
  res.json({ sessionId });
  scraper.searchJobs(sessionId, getProfile(), prefs, linkedinEmail, linkedinPassword)
    .catch(err => console.error("Search crashed:", err));
});

// ── Tailor resume for a specific job (AI — runs in background, streams via SSE) ─
app.post("/api/applications/:id/tailor", async (req, res) => {
  const jobApp = getApplication(req.params.id);
  if (!jobApp) return res.status(404).json({ error: "Job not found" });
  const profile = getProfile();
  if (!profile.resume_text) return res.status(400).json({ error: "Upload your resume in the Profile tab first" });

  // Acknowledge immediately so the browser doesn't time out
  res.json({ success: true, status: "tailoring" });

  // Broadcast start
  scraper.broadcast("tailor_start", { id: req.params.id, job_title: jobApp.job_title });

  try {
    const [tailoredResume, coverLetter] = await Promise.all([
      ai.tailorResume(jobApp.job_title, jobApp.job_description || "", profile),
      ai.generateCoverLetter(jobApp.job_title, jobApp.company || "", jobApp.job_description || "", profile),
    ]);

    const updated = {
      ...jobApp,
      tailored_resume: tailoredResume,
      cover_letter:    coverLetter,
    };
    upsertApplication(updated);

    // Broadcast completion with the tailored data so the UI can update live
    scraper.broadcast("tailor_complete", {
      id:             req.params.id,
      tailored_resume: tailoredResume,
      cover_letter:    coverLetter,
    });
  } catch (err) {
    console.error("Tailor error:", err);
    scraper.broadcast("tailor_error", { id: req.params.id, error: err.message });
  }
});

// ── Download tailored resume ─────────────────────────────────────────────────
app.get("/api/applications/:id/download-resume", (req, res) => {
  const a = getApplication(req.params.id);
  if (!a) return res.status(404).json({ error: "Not found" });
  if (!a.tailored_resume) return res.status(404).json({ error: "No tailored resume yet — click Tailor first" });
  const name = ((a.job_title || "Resume") + "_" + (a.company || "")).replace(/[^a-z0-9_\-]/gi, "_").slice(0, 60);
  const fmt  = req.query.format || "txt";
  if (fmt === "txt") {
    res.setHeader("Content-Disposition", `attachment; filename="${name}_Tailored.txt"`);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.send(a.tailored_resume);
  }
  // DOCX — simple paragraph-based generation
  try {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require("docx");
    const lines = a.tailored_resume.split("\n");
    const children = lines.map(line => {
      const trimmed = line.trim();
      if (!trimmed) return new Paragraph({ spacing: { after: 80 } });
      // Heuristic: ALL CAPS short lines = section heading
      if (/^[A-Z][A-Z\s&\/]{3,}$/.test(trimmed) && trimmed.length < 40) {
        return new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: trimmed, bold: true, size: 26 })] });
      }
      // Lines starting with common resume bullets
      if (/^[-•·]/.test(trimmed)) {
        return new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: trimmed.replace(/^[-•·]\s*/, ""), size: 22 })] });
      }
      return new Paragraph({ children: [new TextRun({ text: trimmed, size: 22 })], spacing: { after: 60 } });
    });
    const doc = new Document({ sections: [{ properties: {}, children }] });
    Packer.toBuffer(doc).then(buf => {
      res.setHeader("Content-Disposition", `attachment; filename="${name}_Tailored.docx"`);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      res.send(buf);
    }).catch(err => res.status(500).json({ error: err.message }));
  } catch (err) {
    // Fallback to txt if docx not installed
    res.setHeader("Content-Disposition", `attachment; filename="${name}_Tailored.txt"`);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(a.tailored_resume);
  }
});

// ── Upload resume file directly to an application ────────────────────────────
app.post("/api/applications/:id/upload-resume", upload.single("resume"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const jobApp = getApplication(req.params.id);
    if (!jobApp) return res.status(404).json({ error: "Job not found" });
    const resumeText = await extractText(req.file.buffer, req.file.mimetype, req.file.originalname);

    // Save resume immediately so the user isn't waiting
    upsertApplication({ ...jobApp, tailored_resume: resumeText });
    res.json({ success: true, resume_text: resumeText });

    // Generate cover letter in the background and save it
    try {
      const profile = getProfile();
      const coverLetter = await ai.generateCoverLetter(
        jobApp.job_title, jobApp.company || "", jobApp.job_description || "", profile
      );
      upsertApplication({ ...jobApp, tailored_resume: resumeText, cover_letter: coverLetter });
      scraper.broadcast("tailor_complete", { id: req.params.id, tailored_resume: resumeText, cover_letter: coverLetter });
    } catch (e) {
      console.error("Cover letter generation failed after import:", e.message);
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Save optimized resume from Resume Optimizer (localhost:3001) ──────────────
app.post("/api/applications/:id/save-from-optimized", async (req, res) => {
  const jobApp = getApplication(req.params.id);
  if (!jobApp) return res.status(404).json({ error: "Job not found" });

  // Fetch latest optimized resume from Resume Optimizer
  let resumeText = null;
  try {
    const r = await fetch("http://localhost:3001/api/last-optimized");
    const data = await r.json();
    if (!data.resume_text) return res.status(400).json({ error: "No optimized resume found. Please complete optimization at Resume Optimizer first." });
    resumeText = data.resume_text;
  } catch {
    return res.status(503).json({ error: "Cannot connect to Resume Optimizer at localhost:3001. Is it running?" });
  }

  res.json({ success: true, status: "saving" });
  scraper.broadcast("tailor_start", { id: req.params.id, job_title: jobApp.job_title });

  try {
    const profile = getProfile();
    const coverLetter = await ai.generateCoverLetter(
      jobApp.job_title, jobApp.company || "", jobApp.job_description || "", profile
    );
    upsertApplication({ ...jobApp, tailored_resume: resumeText, cover_letter: coverLetter });
    scraper.broadcast("tailor_complete", { id: req.params.id, tailored_resume: resumeText, cover_letter: coverLetter });
  } catch (err) {
    console.error("Cover letter error:", err);
    // Still save the resume even if cover letter fails
    upsertApplication({ ...jobApp, tailored_resume: resumeText });
    scraper.broadcast("tailor_complete", { id: req.params.id, tailored_resume: resumeText, cover_letter: "" });
  }
});

// ── Apply to a single job ─────────────────────────────────────────────────────
app.post("/api/applications/:id/apply", async (req, res) => {
  if (scraper.isRunning()) return res.status(409).json({ error: "A browser session is already running" });
  const { linkedinEmail, linkedinPassword } = req.body;
  if (!linkedinEmail || !linkedinPassword) return res.status(400).json({ error: "LinkedIn credentials required" });
  const jobApp = getApplication(req.params.id);
  if (!jobApp) return res.status(404).json({ error: "Job not found" });
  const sessionId = uuidv4();
  res.json({ sessionId });
  scraper.applyToSingleJob(sessionId, jobApp, getProfile(), linkedinEmail, linkedinPassword)
    .catch(err => console.error("Apply crashed:", err));
});

// ── Serve frontend ────────────────────────────────────────────────────────────
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Job Applier AI running on http://localhost:${PORT}`);
  console.log(`🔑 Anthropic key: ${process.env.ANTHROPIC_API_KEY ? "loaded ✓" : "MISSING ✗"}`);
});
