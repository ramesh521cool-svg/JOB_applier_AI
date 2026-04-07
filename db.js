const fs = require("fs");
const path = require("path");

const DATA_DIR = __dirname;
const FILES = {
  profile:      path.join(DATA_DIR, "data_profile.json"),
  preferences:  path.join(DATA_DIR, "data_preferences.json"),
  applications: path.join(DATA_DIR, "data_applications.json"),
  sessions:     path.join(DATA_DIR, "data_sessions.json"),
};

// ---------- File helpers ----------
function read(file, def) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return def; }
}
function write(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

// ---------- Defaults ----------
const DEFAULT_PROFILE = {
  id: 1, full_name: "", email: "", phone: "", location: "",
  linkedin_url: "", github_url: "", portfolio_url: "",
  resume_text: "", summary: "", updated_at: "",
};

const DEFAULT_PREFS = {
  id: 1,
  job_titles: "[]", locations: "[]",
  remote: 1, hybrid: 1, onsite: 1,
  experience_levels: '["mid-senior level"]',
  job_types: '["full-time"]',
  date_posted: "past_week",
  keywords: "[]", blacklist_companies: "[]", blacklist_titles: "[]",
  min_salary: 0, max_applications: 20, suitability_threshold: 6,
  auto_cover_letter: 1, updated_at: "",
};

// ---------- Profile ----------
function getProfile() {
  return read(FILES.profile, DEFAULT_PROFILE);
}

function saveProfile(data) {
  const profile = getProfile();
  const updated = { ...profile, ...data, updated_at: new Date().toISOString() };
  write(FILES.profile, updated);
}

// ---------- Preferences ----------
function getPrefs() {
  return read(FILES.preferences, DEFAULT_PREFS);
}

function savePrefs(data) {
  const prefs = getPrefs();
  const updated = { ...prefs, ...data, updated_at: new Date().toISOString() };
  write(FILES.preferences, updated);
}

// ---------- Applications ----------
function getApplications(limit = 100) {
  const apps = read(FILES.applications, []);
  return apps
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, limit);
}

function getApplication(id) {
  const apps = read(FILES.applications, []);
  return apps.find(a => a.id === id) || null;
}

function upsertApplication(app) {
  const apps = read(FILES.applications, []);
  const idx = apps.findIndex(a => a.id === app.id);
  if (idx >= 0) {
    // Update only allowed fields
    apps[idx] = {
      ...apps[idx],
      status: app.status ?? apps[idx].status,
      tailored_resume: app.tailored_resume ?? apps[idx].tailored_resume,
      cover_letter: app.cover_letter ?? apps[idx].cover_letter,
      suitability_score: app.suitability_score ?? apps[idx].suitability_score,
      applied_at: app.applied_at ?? apps[idx].applied_at,
      notes: app.notes ?? apps[idx].notes,
    };
  } else {
    apps.push({ ...app, created_at: new Date().toISOString() });
  }
  write(FILES.applications, apps);
}

// ---------- Sessions ----------
function getSession(id) {
  const sessions = read(FILES.sessions, []);
  return sessions.find(s => s.id === id) || null;
}

function createSession(id) {
  const sessions = read(FILES.sessions, []);
  sessions.push({
    id, status: "running",
    jobs_found: 0, jobs_applied: 0, jobs_skipped: 0, jobs_failed: 0,
    started_at: new Date().toISOString(), ended_at: null, log: "[]",
  });
  write(FILES.sessions, sessions);
}

function updateSession(id, data) {
  const sessions = read(FILES.sessions, []);
  const idx = sessions.findIndex(s => s.id === id);
  if (idx >= 0) {
    sessions[idx] = { ...sessions[idx], ...data };
    write(FILES.sessions, sessions);
  }
}

// ---------- Stats ----------
function getStats() {
  const apps = read(FILES.applications, []);
  return {
    total:   apps.length,
    applied: apps.filter(a => a.status === "applied").length,
    skipped: apps.filter(a => a.status === "skipped").length,
    failed:  apps.filter(a => a.status === "failed").length,
    pending: apps.filter(a => a.status === "pending").length,
  };
}

function clearApplications() {
  write(FILES.applications, []);
}

function deleteApplication(id) {
  const apps = read(FILES.applications, []);
  write(FILES.applications, apps.filter(a => a.id !== id));
}

module.exports = {
  getProfile, saveProfile,
  getPrefs, savePrefs,
  getApplications, getApplication, upsertApplication, clearApplications, deleteApplication,
  getSession, createSession, updateSession,
  getStats,
};
