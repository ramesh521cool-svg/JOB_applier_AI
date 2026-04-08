const { chromium } = require("playwright");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");
const ai = require("./ai");
const { upsertApplication, updateSession } = require("./db");

const DEBUG_DIR = path.join(__dirname, "debug");
if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR);

// Persistent browser profile so LinkedIn stays logged in between sessions
const BROWSER_PROFILE = path.join(__dirname, ".browser-profile");

let activeBrowser = null;
let activePage    = null;
let running       = false;
const sseClients  = new Set();

// ---------- SSE helpers ----------
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => { try { res.write(msg); } catch {} });
}
function addClient(res)    { sseClients.add(res); }
function removeClient(res) { sseClients.delete(res); }
function isRunning()       { return running; }

function log(sessionId, level, message) {
  console.log(`[${level.toUpperCase()}] ${message}`);
  broadcast("log", { level, message, timestamp: new Date().toISOString() });
}

// ---------- Launch browser with persistent profile ----------
const IS_HEADLESS = process.env.HEADLESS === "true" || process.env.RENDER === "true" || process.env.NODE_ENV === "production";

const BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-blink-features=AutomationControlled",
  "--disable-infobars",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--disable-extensions",
  "--no-first-run",
  "--no-zygote",
  "--single-process",
  "--disable-background-networking",
  "--disable-default-apps",
  "--mute-audio",
];

// Search recursively for a chromium executable under a directory
function findExeUnder(dir, names, depth = 0) {
  if (depth > 6 || !fs.existsSync(dir)) return null;
  try {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      try {
        const stat = fs.statSync(full);
        if (stat.isFile() && names.includes(entry)) return full;
        if (stat.isDirectory()) {
          const found = findExeUnder(full, names, depth + 1);
          if (found) return found;
        }
      } catch {}
    }
  } catch {}
  return null;
}

// Resolve chromium executable — ask Playwright first, then search, then system fallbacks
function resolveChromiumPath() {
  // 1. Ask Playwright where it expects the browser (respects PLAYWRIGHT_BROWSERS_PATH)
  try {
    const expected = chromium.executablePath();
    console.log("[BROWSER] Playwright expects chromium at:", expected);
    if (fs.existsSync(expected)) {
      console.log("[BROWSER] ✅ Found at expected path");
      return expected;
    }
    console.log("[BROWSER] ❌ Not found at expected path");
  } catch (e) {
    console.log("[BROWSER] executablePath() error:", e.message);
  }

  // 2. Search manually across all known locations
  const exeNames = ["chrome-headless-shell", "chrome", "chromium", "chromium-browser"];
  const searchRoots = [
    path.join(__dirname, "playwright-browsers"),
    "/opt/render/project/src/playwright-browsers",
    process.env.HOME && path.join(process.env.HOME, ".cache", "ms-playwright"),
    "/root/.cache/ms-playwright",
    "/opt/render/.cache/ms-playwright",
  ].filter(Boolean);

  for (const root of searchRoots) {
    const found = findExeUnder(root, exeNames);
    if (found) { console.log("[BROWSER] Found via search:", found); return found; }
  }

  // 3. System chromium
  for (const p of ["/usr/bin/chromium-browser", "/usr/bin/chromium", "/usr/bin/google-chrome"]) {
    if (fs.existsSync(p)) { console.log("[BROWSER] Using system chromium:", p); return p; }
  }

  console.log("[BROWSER] ❌ No chromium found anywhere — Playwright will use its default");
  return undefined;
}

async function launchBrowser() {
  if (IS_HEADLESS) {
    const executablePath = resolveChromiumPath();
    const browser = await chromium.launch({
      headless: true,
      executablePath,
      args: BROWSER_ARGS,
    });
    return browser;
  } else {
    // Local dev: persistent context so LinkedIn stays logged in
    return chromium.launchPersistentContext(BROWSER_PROFILE, {
      headless: false,
      args: ["--no-sandbox", "--disable-blink-features=AutomationControlled", "--disable-infobars"],
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    });
  }
}

async function getPage(ctx) {
  if (IS_HEADLESS) {
    const context = await ctx.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    });
    return context.newPage();
  }
  const pages = ctx.pages();
  return pages.length > 0 ? pages[0] : ctx.newPage();
}

// ---------- LinkedIn login ----------
async function loginLinkedIn(page, email, password) {
  await page.goto("https://www.linkedin.com/login", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);

  // Wait for username field — try multiple selectors
  let filled = false;
  for (const sel of ["#username", "input[name='session_key']", "input[autocomplete='username']", "input[type='email']"]) {
    try {
      await page.waitForSelector(sel, { timeout: 8000 });
      await page.fill(sel, email);
      filled = true;
      break;
    } catch {}
  }
  if (!filled) throw new Error("LinkedIn login form not found — the page may be blocked or changed.");

  for (const sel of ["#password", "input[name='session_password']", "input[type='password']"]) {
    try {
      await page.fill(sel, password);
      break;
    } catch {}
  }

  await page.click('[type="submit"], button[data-litms-control-urn*="login"]').catch(() =>
    page.keyboard.press("Enter")
  );
  await page.waitForTimeout(5000);

  const url = page.url();
  if (url.includes("checkpoint") || url.includes("challenge") || url.includes("verification")) {
    throw new Error("LinkedIn requires verification — please log in manually in the browser that just opened, then retry.");
  }
}

async function ensureLoggedIn(page, email, password, sessionId) {
  // Navigate to feed and check where we land
  try {
    await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 20000 });
  } catch {
    await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(3000);

  const url = page.url();
  // If we landed on login/authwall — not logged in
  const needsLogin = url.includes("/login") || url.includes("/authwall") || url.includes("/uas/") || url.includes("/checkpoint");

  if (!needsLogin) {
    log(sessionId, "success", "✅ Already signed in to LinkedIn");
    return;
  }

  log(sessionId, "info", "🔐 Logging into LinkedIn...");
  await loginLinkedIn(page, email, password);

  const afterUrl = page.url();
  if (afterUrl.includes("/login") || afterUrl.includes("/authwall")) {
    throw new Error("Login failed — please check your LinkedIn email and password.");
  }
  log(sessionId, "success", "✅ Logged in to LinkedIn");
}

// ---------- Build search URL ----------
function buildSearchUrl(prefs, pageNum = 1) {
  const params = new URLSearchParams();
  const titles = JSON.parse(prefs.job_titles || "[]");
  params.set("keywords", titles.join(" OR "));

  const locs = JSON.parse(prefs.locations || "[]");
  if (locs.length) params.set("location", locs[0]);

  const workTypes = [];
  if (prefs.remote) workTypes.push("2");
  if (prefs.hybrid) workTypes.push("3");
  if (prefs.onsite) workTypes.push("1");
  if (workTypes.length) params.set("f_WT", workTypes.join(","));

  const dateMap = { past_24h: "r86400", past_week: "r604800", past_month: "r2592000" };
  if (dateMap[prefs.date_posted]) params.set("f_TPR", dateMap[prefs.date_posted]);

  const expMap = { "entry level": "2", "associate": "3", "mid-senior level": "4", "director": "5" };
  const expLevels = JSON.parse(prefs.experience_levels || "[]").map(e => expMap[e]).filter(Boolean);
  if (expLevels.length) params.set("f_E", expLevels.join(","));

  // Easy Apply filter
  params.set("f_LF", "f_AL");
  params.set("start", ((pageNum - 1) * 25).toString());
  params.set("sortBy", "DD");

  return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
}

// ---------- Scrape job listings ----------
async function scrapeJobListings(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(4000);

  // Wait for job cards to appear
  for (const sel of ["a[href*='/jobs/view/']", "[data-occludable-job-id]", ".job-card-container", ".jobs-search-results__list-item"]) {
    try { await page.waitForSelector(sel, { timeout: 6000 }); break; } catch {}
  }
  await page.waitForTimeout(2000);

  // Debug snapshot
  try {
    const stamp = Date.now();
    await page.screenshot({ path: path.join(DEBUG_DIR, `search_${stamp}.png`) });
    fs.writeFileSync(path.join(DEBUG_DIR, `search_${stamp}.html`), await page.content());
  } catch {}

  console.log("[DEBUG] URL:", page.url(), "| Title:", await page.title().catch(() => "?"));

  const counts = await page.evaluate(() => ({
    links: document.querySelectorAll("a[href*='/jobs/view/']").length,
    occludable: document.querySelectorAll("[data-occludable-job-id]").length,
    cards: document.querySelectorAll(".job-card-container").length,
    liItems: document.querySelectorAll("li.jobs-search-results__list-item").length,
  }));
  console.log("[DEBUG] Selector counts:", counts);

  return page.evaluate(() => {
    const links = Array.from(document.querySelectorAll("a[href*='/jobs/view/']"));
    const seen = new Set();
    const results = [];

    for (const linkEl of links) {
      const href = linkEl.href?.split("?")[0];
      if (!href || seen.has(href)) continue;
      seen.add(href);

      const jobId = href.match(/\/jobs\/view\/(\d+)/)?.[1] || Math.random().toString(36).slice(2);
      const card  = linkEl.closest("li, article, [data-occludable-job-id], [data-job-id], .job-card-container") || linkEl.parentElement;

      let title = (linkEl.getAttribute("aria-label") || linkEl.innerText || "").trim();
      if (!title && card) title = card.querySelector("h3, h4, strong, [class*='title']")?.innerText?.trim() || "";

      let company = "";
      if (card) company = card.querySelector("[class*='subtitle'], [class*='company'], [class*='primary-description'], h4, .artdeco-entity-lockup__subtitle")?.innerText?.trim() || "";

      let location = "";
      if (card) location = card.querySelector("[class*='location'], [class*='metadata'], [class*='caption'], .artdeco-entity-lockup__caption")?.innerText?.trim() || "";

      if (title) results.push({ id: String(jobId), title, company, location, url: href });
      if (results.length >= 25) break;
    }
    return results;
  });
}

// ---------- Scrape job description ----------
async function scrapeJobDetails(page, jobUrl) {
  await page.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
  try {
    await page.waitForSelector(
      ".jobs-description__content, .show-more-less-html__markup, #job-details, .jobs-description-content",
      { timeout: 8000 }
    );
  } catch {}
  await page.waitForTimeout(1000);
  return page.evaluate(() => {
    const el = document.querySelector(
      ".jobs-description__content, .show-more-less-html__markup, #job-details, .jobs-description-content__text, .jobs-box__html-content"
    );
    return el?.innerText?.trim() || document.body.innerText.slice(0, 3000);
  });
}

// ---------- Easy Apply ----------
async function applyToJob(page, jobUrl, tailoredResume, coverLetter, profile, sessionId) {
  await page.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
  await page.waitForTimeout(3000);

  // Debug screenshot before trying to apply
  try {
    await page.screenshot({ path: path.join(DEBUG_DIR, `apply_${Date.now()}.png`) });
  } catch {}
  console.log("[APPLY] URL:", page.url(), "| Title:", await page.title().catch(() => "?"));

  // -- Find Easy Apply button: try aria-label, CSS class, then button text --
  let easyApplyBtn = null;

  // Strategy 1: aria-label contains "Easy Apply"
  for (const sel of [
    "button[aria-label*='Easy Apply']",
    "button[aria-label*='easy apply']",
    ".jobs-apply-button--top-card",
    ".jobs-apply-button",
    ".jobs-s-apply button",
    "[data-control-name='jobdetails_topcard_inapply']",
  ]) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        easyApplyBtn = btn; break;
      }
    } catch {}
  }

  // Strategy 2: any button whose text contains "Easy Apply"
  if (!easyApplyBtn) {
    try {
      const btn = page.getByRole("button", { name: /easy apply/i }).first();
      if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) easyApplyBtn = btn;
    } catch {}
  }

  if (!easyApplyBtn) {
    // Save debug HTML for diagnosis
    try {
      const html = await page.content();
      fs.writeFileSync(path.join(DEBUG_DIR, `apply_fail_${Date.now()}.html`), html);
    } catch {}
    const btns = await page.evaluate(() =>
      Array.from(document.querySelectorAll("button")).slice(0, 20).map(b => b.innerText?.trim()).filter(Boolean)
    );
    console.log("[APPLY] Buttons found on page:", btns);
    return { success: false, reason: `No Easy Apply button found. Buttons: ${btns.slice(0, 5).join(" | ")}` };
  }

  console.log("[APPLY] Easy Apply button found — clicking");
  await easyApplyBtn.click();
  await page.waitForTimeout(2500);

  let step = 0;
  while (step < 12) {
    step++;
    console.log(`[APPLY] Step ${step}`);

    // Success: application sent confirmation
    const successSels = [
      ".jobs-apply-form__confirm-modal",
      "[aria-label='Your application was sent']",
      "h2:has-text('application was sent')",
      "h3:has-text('application was sent')",
      ".artdeco-inline-feedback--success",
      "h2:has-text('Application submitted')",
    ];
    for (const sel of successSels) {
      try {
        if (await page.locator(sel).isVisible({ timeout: 500 }).catch(() => false)) {
          console.log("[APPLY] ✅ Success confirmed:", sel);
          return { success: true };
        }
      } catch {}
    }

    // Submit button — final step
    const submitSels = [
      "button[aria-label='Submit application']",
      "button:has-text('Submit application')",
      "button:has-text('Submit')",
    ];
    for (const sel of submitSels) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
          await btn.click();
          await page.waitForTimeout(3000);
          return { success: true };
        }
      } catch {}
    }

    // Review button
    const reviewSels = [
      "button[aria-label='Review your application']",
      "button:has-text('Review')",
    ];
    for (const sel of reviewSels) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
          await btn.click(); await page.waitForTimeout(2000); break;
        }
      } catch {}
    }

    // Fill text/textarea/select fields
    const questions = await page.evaluate(() => {
      const items = [];
      document.querySelectorAll(
        ".jobs-easy-apply-form-section__grouping, .fb-form-element, .jobs-easy-apply-form-element"
      ).forEach(el => {
        const label = el.querySelector("label, legend, .fb-form-element__label")?.innerText?.trim() || "";
        const input = el.querySelector("input:not([type='hidden']):not([type='radio']):not([type='checkbox']), textarea, select");
        if (!input) return;
        items.push({
          label,
          type:  input.tagName.toLowerCase(),
          id:    input.id || input.name || "",
          value: (input.tagName === "SELECT" ? input.options[input.selectedIndex]?.value : input.value) || "",
          name:  input.name || "",
        });
      });
      return items.filter(q => q.label || q.id || q.name);
    });

    for (const q of questions) {
      if (q.value && q.value !== "Select an option" && q.value !== "") continue;
      let answer = "";
      const lbl = q.label.toLowerCase();
      if (/phone|mobile/.test(lbl))                        answer = profile.phone || "";
      else if (/email/.test(lbl))                          answer = profile.email || "";
      else if (/\bname\b/.test(lbl) && !/company/.test(lbl)) answer = profile.full_name || "";
      else if (/cover letter/.test(lbl) && q.type === "textarea") answer = coverLetter || "";
      else if (/years.*(experience|exp)|experience.*year/.test(lbl)) answer = "5";
      else if (/salary|compensation|pay/.test(lbl))        answer = "80000";
      else if (/city|location/.test(lbl))                  answer = profile.location || "";
      else if (/linkedin|website|portfolio/.test(lbl))     answer = profile.linkedin_url || profile.github_url || "";
      else if (q.type === "select") {
        // Pick first non-placeholder option
        const opts = await page.evaluate(id => {
          const sel = document.getElementById(id) || document.querySelector(`[name="${id}"]`);
          return sel ? Array.from(sel.options).map(o => o.value).filter(v => v) : [];
        }, q.id || q.name);
        answer = opts[0] || "";
      } else {
        try { answer = (await ai.answerQuestion(q.label, "", "", profile)).slice(0, 250); } catch {}
      }
      if (answer) {
        try {
          const locator = (q.id ? page.locator(`#${q.id}`) : page.locator(`[name="${q.name}"]`)).first();
          if (q.type === "select") await locator.selectOption({ index: 1 }).catch(() => {});
          else await locator.fill(answer).catch(() => {});
          await page.waitForTimeout(400);
        } catch {}
      }
    }

    // Handle radio groups — "Yes" for authorization/work eligibility
    await page.evaluate(() => {
      document.querySelectorAll(".fb-form-element, .jobs-easy-apply-form-section__grouping").forEach(el => {
        const legend = (el.querySelector("legend, .fb-form-element__label")?.innerText || "").toLowerCase();
        if (/authorized|eligible|legally|sponsorship|citizen|right to work/i.test(legend)) {
          const yes = el.querySelector('input[value="Yes"], input[value="yes"], label:has-text("Yes") input');
          if (yes && !yes.checked) yes.click();
        }
      });
    }).catch(() => {});

    // Handle select dropdowns left on placeholder
    await page.evaluate(() => {
      document.querySelectorAll("select").forEach(sel => {
        if (!sel.value || sel.value === "") {
          const opts = Array.from(sel.options).filter(o => o.value);
          if (opts.length) sel.value = opts[0].value;
        }
      });
    }).catch(() => {});

    // Next / Continue button
    let advanced = false;
    for (const sel of [
      "button[aria-label='Continue to next step']",
      "button[aria-label='Next']",
      "button:has-text('Next')",
      "button:has-text('Continue')",
    ]) {
      try {
        const btn = page.locator(sel).last();
        if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await btn.click(); await page.waitForTimeout(2000); advanced = true; break;
        }
      } catch {}
    }
    if (!advanced) {
      console.log("[APPLY] No Next button found — stopping at step", step);
      break;
    }
  }

  try { await page.screenshot({ path: path.join(DEBUG_DIR, `apply_end_${Date.now()}.png`) }); } catch {}
  return { success: false, reason: "Could not complete form in " + step + " steps" };
}

// ============================================================
// NEW: Search-only mode — finds jobs, stores as "found"
// ============================================================
async function searchJobs(sessionId, profile, prefs, email, password) {
  if (running) throw new Error("A browser session is already running");
  running = true;

  try {
    log(sessionId, "info", "🚀 Launching browser — searching LinkedIn...");
    broadcast("status", { status: "searching", sessionId });

    activeBrowser = await launchBrowser();
    activePage    = await getPage(activeBrowser);

    await ensureLoggedIn(activePage, email, password, sessionId);

    const jobTitles         = JSON.parse(prefs.job_titles || "[]");
    const blacklistCompanies = new Set(JSON.parse(prefs.blacklist_companies || "[]").map(c => c.toLowerCase()));
    const blacklistTitles    = JSON.parse(prefs.blacklist_titles || "[]").map(t => t.toLowerCase());
    const maxJobs            = Math.min(Number(prefs.max_applications) || 20, 50);
    const allJobs            = [];

    for (const title of jobTitles.slice(0, 3)) {
      if (allJobs.length >= maxJobs) break;
      const searchUrl = buildSearchUrl({ ...prefs, job_titles: JSON.stringify([title]) }, 1);
      log(sessionId, "info", `🔍 Searching: "${title}"...`);

      let jobs = [];
      try { jobs = await scrapeJobListings(activePage, searchUrl); } catch (err) {
        log(sessionId, "warn", `Search failed for "${title}": ${err.message}`); continue;
      }

      log(sessionId, "info", `📋 Found ${jobs.length} listings for "${title}"`);

      for (const job of jobs) {
        if (allJobs.length >= maxJobs) break;
        if (!job.title || !job.url) continue;
        if (blacklistCompanies.has((job.company || "").toLowerCase())) continue;
        if (blacklistTitles.some(t => job.title.toLowerCase().includes(t))) continue;

        log(sessionId, "info", `📄 Fetching details: ${job.title} @ ${job.company}`);
        let jobDesc = "";
        try { jobDesc = await scrapeJobDetails(activePage, job.url); } catch {}

        const appId = job.id || uuidv4();

        // Score with Claude AI
        log(sessionId, "info", `🎯 Scoring: ${job.title}…`);
        let score = { score: 0, reason: "", match_keywords: [], gap_keywords: [] };
        try { score = await ai.scoreJob(job.title, jobDesc, profile, prefs); } catch (e) {
          console.error("[SCORE ERROR]", e.message);
        }
        log(sessionId, "info", `✅ Score ${score.score}/10 — ${job.title}`);

        upsertApplication({
          id: appId, job_title: job.title, company: job.company || "",
          location: job.location || "", job_url: job.url,
          job_description: jobDesc, status: "found",
          suitability_score: score.score, suitability_reason: score.reason,
          tailored_resume: "", cover_letter: "", notes: "",
        });

        broadcast("job_found", {
          id: appId, job_title: job.title, company: job.company,
          location: job.location, url: job.url,
          score: score.score, reason: score.reason,
        });
        allJobs.push({ id: appId, ...job, description: jobDesc, score: score.score });
        if (activePage) await activePage.waitForTimeout(1000 + Math.random() * 1000);
      }
    }

    broadcast("status", { status: "search_complete", jobsFound: allJobs.length });
    log(sessionId, "success", `✅ Search complete! Found ${allJobs.length} jobs. Review and apply below.`);
    return allJobs;

  } catch (err) {
    log(sessionId, "error", `💥 Search error: ${err.message}`);
    throw err;
  } finally {
    running = false;
    if (activeBrowser) { try { await activeBrowser.close(); } catch {} activeBrowser = null; activePage = null; }
  }
}

// ============================================================
// Apply to a single job — navigates directly to the job page
// ============================================================
async function applyToSingleJob(sessionId, application, profile, email, password) {
  if (running) throw new Error("A browser session is already running");
  running = true;

  try {
    const jobUrl = application.job_url;
    if (!jobUrl) throw new Error("No job URL stored. Please search for jobs again.");

    log(sessionId, "info", `📨 Opening LinkedIn job page...`);
    log(sessionId, "info", `🔗 ${application.job_title} @ ${application.company}`);
    broadcast("status", { status: "applying", sessionId, jobId: application.id });

    activeBrowser = await launchBrowser();
    activePage    = await getPage(activeBrowser);

    // ── Step 1: Navigate directly to the job page ──────────────────
    log(sessionId, "info", `🌐 Navigating to job page...`);
    await activePage.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await activePage.waitForTimeout(3000);

    const landedUrl = activePage.url();
    log(sessionId, "info", `📍 Landed on: ${landedUrl.slice(0, 80)}`);

    // ── Step 2: Handle login redirect ──────────────────────────────
    if (
      landedUrl.includes("/login") ||
      landedUrl.includes("/checkpoint") ||
      landedUrl.includes("/authwall") ||
      landedUrl.includes("/uas/")
    ) {
      log(sessionId, "info", "🔐 Login required — signing in...");
      if (!email || !password) throw new Error("LinkedIn credentials required. Enter them in the Run tab.");
      await loginLinkedIn(activePage, email, password);
      // Navigate back to the job after login
      log(sessionId, "info", "🔄 Navigating back to job page after login...");
      await activePage.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await activePage.waitForTimeout(3000);
    } else {
      log(sessionId, "success", "✅ Already signed in to LinkedIn");
    }

    // ── Step 3: Wait for Easy Apply element to appear (up to 20s) ──
    // LinkedIn uses <a> tags (not <button>) for Easy Apply — search both
    log(sessionId, "info", "⏳ Waiting for Easy Apply to render...");
    const stamp = Date.now();

    const findEasyApply = () => activePage.evaluate(() => {
      // Search both <button> AND <a> tags — LinkedIn changed to <a>
      const els = Array.from(document.querySelectorAll("button, a"));
      const el = els.find(e =>
        /easy apply/i.test(e.innerText?.trim()) ||
        /easy apply/i.test(e.getAttribute("aria-label") || "")
      );
      if (!el) return null;
      return { tag: el.tagName, text: el.innerText?.trim(), aria: el.getAttribute("aria-label"), href: el.href || "" };
    });

    let easyApplyInfo = null;
    for (let attempt = 1; attempt <= 10; attempt++) {
      await activePage.evaluate(() => window.scrollTo(0, 200)).catch(() => {});
      await activePage.waitForTimeout(2000);
      easyApplyInfo = await findEasyApply();
      if (easyApplyInfo) {
        log(sessionId, "info", `✅ Found Easy Apply <${easyApplyInfo.tag}> on attempt ${attempt}: "${easyApplyInfo.aria || easyApplyInfo.text}"`);
        break;
      }
      log(sessionId, "info", `⏳ Attempt ${attempt}/10 — Easy Apply not yet visible...`);
    }

    // Debug screenshot
    try { await activePage.screenshot({ path: path.join(DEBUG_DIR, `job_page_${stamp}.png`) }); } catch {}
    const pageTitle = await activePage.title().catch(() => "?");
    log(sessionId, "info", `📄 Page: "${pageTitle}"`);

    if (!easyApplyInfo) {
      try { fs.writeFileSync(path.join(DEBUG_DIR, `no_button_${stamp}.html`), await activePage.content()); } catch {}
      throw new Error("Easy Apply not found after 20s — this job may not support Easy Apply or requires login.");
    }

    // ── Step 4: Click Easy Apply ───────────────────────────────────
    log(sessionId, "info", `🖱️ Clicking Easy Apply <${easyApplyInfo.tag}>...`);

    // If it's an <a> with an apply URL, navigate to it directly
    if (easyApplyInfo.tag === "A" && easyApplyInfo.href && easyApplyInfo.href.includes("/apply/")) {
      log(sessionId, "info", `🔗 Navigating to apply URL: ${easyApplyInfo.href.slice(0, 80)}`);
      await activePage.goto(easyApplyInfo.href, { waitUntil: "domcontentloaded", timeout: 20000 });
      await activePage.waitForTimeout(3000);
    } else {
      // Click via JS (works for both <a> and <button>)
      await activePage.evaluate(() => {
        const els = Array.from(document.querySelectorAll("button, a"));
        const el = els.find(e =>
          /easy apply/i.test(e.innerText?.trim()) ||
          /easy apply/i.test(e.getAttribute("aria-label") || "")
        );
        if (el) { el.scrollIntoView({ block: "center" }); el.click(); }
      });
      await activePage.waitForTimeout(4000);
    }

    // Check if modal/apply dialog opened
    const modalOpen = await activePage.evaluate(() =>
      !!document.querySelector("[role='dialog'], .artdeco-modal, .jobs-easy-apply-modal")
    );
    if (!modalOpen) {
      // Try Playwright locator as backup
      log(sessionId, "info", "⚠️ Modal not detected — trying Playwright click...");
      for (const sel of [
        "a[aria-label*='Easy Apply' i]",
        "button[aria-label*='Easy Apply' i]",
        "[aria-label*='Easy Apply' i]",
      ]) {
        try {
          const el = activePage.locator(sel).first();
          if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
            await el.click({ force: true });
            log(sessionId, "info", `✅ Playwright clicked: ${sel}`);
            await activePage.waitForTimeout(3000);
            break;
          }
        } catch {}
      }
    }

    log(sessionId, "info", "📝 Easy Apply modal opened — auto-filling form...");

    // ── Step 7: Auto-fill the multi-step form (stops before Submit) ─
    const resume  = application.tailored_resume || profile.resume_text || "";
    const cletter = application.cover_letter || "";
    const fillResult = await fillEasyApplyForm(activePage, resume, cletter, profile, sessionId);

    // ── Step 8: Wait for user to review & submit (or auto-submit) ──
    let finalStatus = "failed";
    let finalNotes  = "";

    if (fillResult.success) {
      // Already auto-submitted (rare — success modal appeared during filling)
      finalStatus = "applied";
      log(sessionId, "success", `🎉 Auto-submitted! Applied to ${application.job_title}!`);
    } else {
      // Prompt user to review and submit
      log(sessionId, "warn", "⏸️ ══════════════════════════════════════════════");
      log(sessionId, "warn", "⏸️  REVIEW YOUR APPLICATION IN THE BROWSER WINDOW");
      log(sessionId, "warn", "⏸️  Make any changes, then click SUBMIT.");
      log(sessionId, "warn", "⏸️  Dashboard will update automatically when done.");
      log(sessionId, "warn", "⏸️ ══════════════════════════════════════════════");

      // Poll every 3s for up to 10 minutes for submission confirmation
      const submitted = await pollForSubmission(activePage, sessionId);
      if (submitted) {
        finalStatus = "applied";
        log(sessionId, "success", `🎉 Application submitted! ${application.job_title} @ ${application.company}`);
      } else {
        finalStatus = "failed";
        finalNotes  = fillResult.reason || "Timed out waiting for submission";
        log(sessionId, "warn", `❌ Application not submitted: ${finalNotes}`);
      }
    }

    // ── Step 9: Update dashboard ───────────────────────────────────
    upsertApplication({
      ...application, status: finalStatus,
      applied_at: finalStatus === "applied" ? new Date().toISOString() : null,
      notes: finalNotes,
    });
    broadcast("application_update", { id: application.id, status: finalStatus, score: application.suitability_score });
    return { success: finalStatus === "applied" };

  } catch (err) {
    log(sessionId, "error", `💥 Apply error: ${err.message}`);
    upsertApplication({ ...application, status: "failed", notes: err.message });
    broadcast("application_update", { id: application.id, status: "failed", score: application.suitability_score });
    return { success: false, reason: err.message };
  } finally {
    running = false;
    if (activeBrowser) { try { await activeBrowser.close(); } catch {} activeBrowser = null; activePage = null; }
    broadcast("status", { status: "idle" });
  }
}

// ── Multi-step Easy Apply form filler ──────────────────────────────────────
async function fillEasyApplyForm(page, tailoredResume, coverLetter, profile, sessionId) {
  let step = 0;
  while (step < 15) {
    step++;
    log(sessionId, "info", `📋 Form step ${step}...`);
    await page.waitForTimeout(1500);

    // ── Check success ──
    const successSels = [
      ".jobs-apply-form__confirm-modal",
      "[aria-label='Your application was sent']",
      "h2:has-text('application was sent')",
      "h3:has-text('application was sent')",
      "h2:has-text('Application submitted')",
      ".artdeco-inline-feedback--success",
      "p:has-text('Your application was sent')",
    ];
    for (const sel of successSels) {
      try {
        if (await page.locator(sel).isVisible({ timeout: 800 }).catch(() => false)) {
          log(sessionId, "success", "🎉 Application confirmed as sent!");
          return { success: true };
        }
      } catch {}
    }

    // ── Submit button (final step) — STOP here and let user review ──
    for (const sel of ["button[aria-label='Submit application']", "button:has-text('Submit application')"]) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
          log(sessionId, "warn", "✋ Form filled! Submit button is ready.");
          log(sessionId, "warn", "👀 Please review your application in the browser.");
          log(sessionId, "warn", "📤 Click SUBMIT when you're happy with it.");
          return { success: false, waitingForUser: true };
        }
      } catch {}
    }

    // ── Review button ──
    for (const sel of ["button[aria-label='Review your application']", "button:has-text('Review')"]) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
          log(sessionId, "info", "🔍 Clicking Review...");
          await btn.click();
          await page.waitForTimeout(1500);
          continue;
        }
      } catch {}
    }

    // ── Fill all visible fields ──
    const fields = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll(
        ".jobs-easy-apply-form-section__grouping, .fb-form-element, .jobs-easy-apply-form-element"
      ).forEach(el => {
        const label = (
          el.querySelector("label, legend, .fb-form-element__label, [data-test-form-element-label]")?.innerText || ""
        ).trim();
        const inputs = Array.from(el.querySelectorAll(
          "input:not([type=hidden]):not([type=radio]):not([type=checkbox]), textarea, select"
        ));
        inputs.forEach(inp => {
          const val = inp.tagName === "SELECT"
            ? (inp.options[inp.selectedIndex]?.value || "")
            : (inp.value || "");
          results.push({
            label, tag: inp.tagName.toLowerCase(),
            id: inp.id, name: inp.name,
            value: val, placeholder: inp.placeholder || "",
          });
        });
      });
      return results;
    });

    for (const f of fields) {
      const lbl = (f.label + " " + f.placeholder).toLowerCase();
      // Skip already-filled fields (except empty-looking selects)
      if (f.value && f.tag !== "select") continue;
      if (f.tag === "select" && f.value && f.value !== "" && f.value !== "Select an option") continue;

      let answer = "";
      if (/phone|mobile|tel/.test(lbl))                        answer = profile.phone || "";
      else if (/email/.test(lbl))                              answer = profile.email || "";
      else if (/\bfirst.?name/.test(lbl))                      answer = (profile.full_name || "").split(" ")[0] || "";
      else if (/\blast.?name/.test(lbl))                       answer = (profile.full_name || "").split(" ").slice(1).join(" ") || "";
      else if (/\bname\b/.test(lbl) && !/company/.test(lbl))   answer = profile.full_name || "";
      else if (/cover letter/.test(lbl) && f.tag === "textarea") answer = coverLetter || "";
      else if (/linkedin|profile url/.test(lbl))               answer = profile.linkedin_url || "";
      else if (/website|portfolio|github/.test(lbl))           answer = profile.github_url || profile.portfolio_url || "";
      else if (/city|location/.test(lbl))                      answer = profile.location || "";
      else if (/year.*(experience|exp)|experience.*year/.test(lbl)) answer = "5";
      else if (/salary|compensation|pay|ctc/.test(lbl))        answer = "80000";
      else if (/notice|availability/.test(lbl))                answer = "2 weeks";
      else if (f.tag === "select") {
        // Pick first non-empty option
        const firstOpt = await page.evaluate(({ id, name }) => {
          const el = document.getElementById(id) || document.querySelector(`[name="${name}"]`);
          if (!el) return "";
          const opts = Array.from(el.options).filter(o => o.value && o.value !== "");
          return opts[0]?.value || "";
        }, f).catch(() => "");
        answer = firstOpt;
      } else {
        try { answer = (await ai.answerQuestion(f.label || f.placeholder, "", "", profile)).slice(0, 250); } catch {}
      }

      if (!answer) continue;
      try {
        const locator = f.id
          ? page.locator(`#${f.id}`).first()
          : page.locator(`[name="${f.name}"]`).first();
        if (f.tag === "select") {
          await locator.selectOption({ value: answer }).catch(async () => {
            await locator.selectOption({ index: 1 }).catch(() => {});
          });
        } else {
          await locator.fill(answer);
        }
        await page.waitForTimeout(300);
      } catch {}
    }

    // ── Handle radio buttons (Yes/No questions) ──
    await page.evaluate(() => {
      document.querySelectorAll(
        ".fb-form-element, .jobs-easy-apply-form-section__grouping, .jobs-easy-apply-form-element"
      ).forEach(el => {
        const legend = (el.querySelector("legend, .fb-form-element__label")?.innerText || "").toLowerCase();
        if (/authoriz|eligible|legally|sponsorship|citizen|right to work|us.work/i.test(legend)) {
          const yes = el.querySelector('input[value="Yes"], input[value="yes"]');
          if (yes && !yes.checked) { yes.click(); return; }
        }
        // For unanswered Yes/No, default to Yes
        const radios = Array.from(el.querySelectorAll('input[type="radio"]'));
        const noneChecked = radios.length > 0 && radios.every(r => !r.checked);
        if (noneChecked) {
          const yesOpt = radios.find(r => /yes/i.test(r.value) || /yes/i.test(r.nextSibling?.textContent));
          if (yesOpt) yesOpt.click();
          else if (radios[0]) radios[0].click(); // pick first option
        }
      });
    }).catch(() => {});

    await page.waitForTimeout(500);

    // ── Click Next / Continue ──
    let advanced = false;
    const nextSels = [
      "button[aria-label='Continue to next step']",
      "button[aria-label='Next']",
      "button:has-text('Next')",
      "button:has-text('Continue')",
      ".artdeco-button--primary:not([aria-label*='Submit']):not([aria-label*='Review'])",
    ];
    for (const sel of nextSels) {
      try {
        const btn = page.locator(sel).last();
        if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
          const txt = await btn.innerText().catch(() => "");
          if (/discard|cancel|close/i.test(txt)) continue;
          log(sessionId, "info", `➡️ Clicking: "${txt || sel}"`);
          await btn.click();
          await page.waitForTimeout(2000);
          advanced = true;
          break;
        }
      } catch {}
    }

    if (!advanced) {
      log(sessionId, "warn", `⚠️ No Next button on step ${step} — stopping`);
      // Take final screenshot for debug
      try { await page.screenshot({ path: path.join(DEBUG_DIR, `form_end_${Date.now()}.png`) }); } catch {}
      break;
    }
  }

  return { success: false, reason: `Form not fully submitted after ${step} steps` };
}

// ── Poll for submission confirmation (up to 10 min) ──────────────────────────
async function pollForSubmission(page, sessionId) {
  log(sessionId, "info", "⏳ Waiting for you to submit (up to 10 min)...");
  for (let poll = 0; poll < 200; poll++) {
    await new Promise(r => setTimeout(r, 3000));
    if (!page || page.isClosed()) {
      log(sessionId, "warn", "Browser was closed.");
      break;
    }

    // Check for success confirmation on page
    const submitted = await page.evaluate(() => {
      const text = (document.body?.innerText || "").toLowerCase();
      return (
        text.includes("application was sent") ||
        text.includes("application submitted") ||
        text.includes("successfully applied") ||
        text.includes("your application was sent") ||
        !!document.querySelector(
          ".jobs-apply-form__confirm-modal, [aria-label='Your application was sent'], .artdeco-inline-feedback--success"
        )
      );
    }).catch(() => false);

    if (submitted) {
      log(sessionId, "success", "✅ Submission detected!");
      return true;
    }

    // Log progress every 30 seconds
    if (poll > 0 && poll % 10 === 0) {
      log(sessionId, "info", `⏳ Still waiting for submission... (${poll * 3}s elapsed)`);
    }
  }
  log(sessionId, "warn", "⏱️ Timed out waiting for submission (10 min).");
  return false;
}

async function stopSession() {
  running = false;
  if (activeBrowser) { try { await activeBrowser.close(); } catch {} activeBrowser = null; activePage = null; }
  broadcast("status", { status: "stopped" });
}

module.exports = {
  searchJobs, applyToSingleJob, stopSession,
  isRunning, addClient, removeClient, broadcast,
};
