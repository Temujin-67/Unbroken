(function () {
  "use strict";

  var APP_BUILD = "__APP_BUILD__";
  var deviceWasNew = false;
  try { deviceWasNew = !localStorage.getItem("sobeit_device_id"); } catch (e) {}

  // ---------- Mobile viewport height fix (iOS Safari dvh timing bug) ----------
  function setAppHeight() {
    document.documentElement.style.setProperty("--app-height", window.innerHeight + "px");
  }
  setAppHeight();
  window.addEventListener("resize", setAppHeight);
  window.addEventListener("orientationchange", setAppHeight);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", setAppHeight);
  }

  // ---------- Supabase (best-effort — app works fully offline if this fails) ----------
  var supabase = null;
  var currentUserId = null;
  var currentAccessToken = null;
  try {
    var cfg = window.UNBROKEN_CONFIG;
    if (cfg && window.supabase) {
      supabase = window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey);
    }
  } catch (e) {
    console.warn("Supabase init skipped:", e);
  }

  var authDebugInfo = "ensureAuth not yet run";

  // Backup login without the Supabase library (for older phones where it fails to load).
  // Keeps the Companion working: it only needs an access token.
  function rawAnonymousAuth() {
    var c = window.UNBROKEN_CONFIG;
    if (!c || !window.fetch) { authDebugInfo += "raw auth unavailable"; return Promise.resolve(null); }
    var headers = { "Content-Type": "application/json", "apikey": c.supabasePublishableKey };
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem("sobeit_raw_session") || "null"); } catch (e) {}
    function keep(data, how) {
      if (!data || !data.access_token || !data.user) throw new Error("no session in response");
      var sess = { access_token: data.access_token, refresh_token: data.refresh_token, user_id: data.user.id,
        expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600) };
      try { localStorage.setItem("sobeit_raw_session", JSON.stringify(sess)); } catch (e) {}
      currentUserId = sess.user_id;
      currentAccessToken = sess.access_token;
      authDebugInfo += how;
      return currentUserId;
    }
    function signUp() {
      return fetch(c.supabaseUrl + "/auth/v1/signup", { method: "POST", headers: headers, body: "{}" })
        .then(function (r) { return r.json(); }).then(function (d) { return keep(d, "raw signup ok"); });
    }
    var p;
    if (saved && saved.access_token && saved.expires_at > Math.floor(Date.now() / 1000) + 60) {
      currentUserId = saved.user_id; currentAccessToken = saved.access_token; authDebugInfo += "raw session reused";
      p = Promise.resolve(currentUserId);
    } else if (saved && saved.refresh_token) {
      p = fetch(c.supabaseUrl + "/auth/v1/token?grant_type=refresh_token", { method: "POST", headers: headers, body: JSON.stringify({ refresh_token: saved.refresh_token }) })
        .then(function (r) { return r.json(); }).then(function (d) { return keep(d, "raw refresh ok"); })
        .catch(function () { return signUp(); });
    } else {
      p = signUp();
    }
    return p.catch(function (e) { authDebugInfo += "raw auth failed: " + (e && e.message ? e.message : e); return null; });
  }


  function ensureAuth() {
    if (!supabase) { authDebugInfo = "supabase client is null; "; return rawAnonymousAuth(); }
    return supabase.auth.getSession().then(function (res) {
      if (res.error) { authDebugInfo = "getSession error: " + res.error.message; }
      if (res.data.session) {
        currentUserId = res.data.session.user.id;
        currentAccessToken = res.data.session.access_token;
        authDebugInfo = "existing session found";
        return currentUserId;
      }
      authDebugInfo = "no existing session, attempting signInAnonymously";
      return supabase.auth.signInAnonymously().then(function (res2) {
        if (res2.error) {
          authDebugInfo = "signInAnonymously error: " + res2.error.message + " (status: " + (res2.error.status || "?") + ")";
          console.warn("Anonymous sign-in not available yet:", res2.error.message);
          return null;
        }
        currentUserId = res2.data.user.id;
        currentAccessToken = res2.data.session.access_token;
        authDebugInfo = "signInAnonymously succeeded";
        return currentUserId;
      });
    }).catch(function (e) {
      authDebugInfo = "ensureAuth threw: " + (e && e.message ? e.message : String(e));
      console.warn("Auth skipped, running local-only:", e);
      return null;
    });
  }

  // ---------- RevenueCat (Companion paywall) ----------
  // Only real inside a compiled native app — the Capacitor plugin does nothing in a plain
  // browser, so browser testing (like this GitHub Pages preview) always treats Companion as
  // unlocked. Real enforcement only happens in the actual installed app.
  var isNativeApp = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  var RCPurchases = (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Purchases) || null;
  var InAppReview = (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.InAppReview) || null;

  function maybeRequestReview(day) {
    if (!isNativeApp || !InAppReview) return;
    if (day !== 7 && day !== 30) return;
    if (localStorage.getItem("unbroken_review_requested")) return;
    try {
      var result = InAppReview.requestReview();
      if (result && typeof result.catch === "function") {
        result.catch(function (e) {
          console.warn("[Unbroken] Review request failed:", e);
        });
      }
      localStorage.setItem("unbroken_review_requested", "1");
    } catch (e) {
      console.warn("[Unbroken] Review request threw synchronously:", e);
    }
  }

  var COMPANION_ENTITLEMENT_ID = "companion_access";
  var COMPANION_PRODUCT_ID = "com.temujin67.unbroken.companion.lifetime";
  // Web gets the same 5-message trial as the apps. Add ?testmode=1 to the web address for unlimited testing.
  var hasCompanionAccess = /[?&]testmode=1\b/.test(window.location.search);
  var PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=com.temujin67.unbroken";
  // iPhone sales switch (config.js). While off, the iPhone paywall shows "Coming soon" with no buy option.
  var IOS_SALES_OFF = isNativeApp && window.Capacitor.getPlatform && window.Capacitor.getPlatform() === "ios" &&
    !(cfg && cfg.iosPurchasesEnabled === true);

  // ---------- Free trial: N Companion messages in total (N comes from the app_config table) ----------
  var FREE_TRIAL_MESSAGES = 5;
  try {
    var cachedLimit = parseInt(localStorage.getItem("sobeit_free_limit") || "", 10);
    if (cachedLimit > 0 && cachedLimit < 50) FREE_TRIAL_MESSAGES = cachedLimit;
  } catch (e) {}
  var trialNoticeShown = false;

  function hashString(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) { h = ((h << 5) - h + str.charCodeAt(i)) | 0; }
    return Math.abs(h);
  }

  // Reads the free-message limit from the server, so it can change without a new build.
  // free_messages_test = "3,5" splits NEW users (no free message used yet) at random by device;
  // anyone already in a group keeps it. Any failure keeps the last known value (or 5).
  function applyAppConfig(map) {
    var plat = platformName();
    var key = "free_messages_" + (plat === "ios" ? "ios" : plat === "android" ? "android" : "web");
    var n = parseInt(map[key], 10);
    var test = String(map.free_messages_test || "off").replace(/\s/g, "");
    if (/^\d+(,\d+)+$/.test(test)) {
      var options = test.split(",").map(function (x) { return parseInt(x, 10); });
      var variant = null;
      try { variant = parseInt(localStorage.getItem("sobeit_free_variant") || "", 10); } catch (e) {}
      if (!(options.indexOf(variant) !== -1)) {
        variant = null;
        if (freeMessagesUsed() === 0 && !hasCompanionAccess) {
          variant = options[hashString(getDeviceId()) % options.length];
          try { localStorage.setItem("sobeit_free_variant", String(variant)); } catch (e) {}
          trackEvent("variant", "free_" + variant);
        }
      }
      if (variant) n = variant;
    }
    if (n > 0 && n < 50) {
      FREE_TRIAL_MESSAGES = n;
      try { localStorage.setItem("sobeit_free_limit", String(n)); } catch (e) {}
    }
  }

  function loadAppConfig() {
    var c = window.UNBROKEN_CONFIG;
    if (!c || !window.fetch) return Promise.resolve();
    return fetch(c.supabaseUrl + "/rest/v1/app_config?select=key,value", { headers: { "apikey": c.supabasePublishableKey } })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rows) {
        var map = {};
        (rows || []).forEach(function (row) { map[row.key] = row.value; });
        applyAppConfig(map);
      }).catch(function (e) { console.warn("[So Be It] config load failed:", e); });
  }
  function freeMessagesUsed() {
    return parseInt(localStorage.getItem("unbroken_free_used") || "0", 10);
  }
  function freeMessagesLeft() {
    return Math.max(0, FREE_TRIAL_MESSAGES - freeMessagesUsed());
  }
  function useFreeMessage() {
    localStorage.setItem("unbroken_free_used", String(freeMessagesUsed() + 1));
  }
  // Never lock someone out of an active safety conversation.
  function canUseCompanion() {
    return hasCompanionAccess || freeMessagesLeft() > 0 || isSafetyActive();
  }

  function initRevenueCat() {
    if (!isNativeApp) return Promise.resolve();
    if (!RCPurchases) {
      console.warn("[Unbroken] RevenueCat plugin not found on window.Capacitor.Plugins.Purchases.");
      return Promise.resolve();
    }
    var platform = window.Capacitor.getPlatform ? window.Capacitor.getPlatform() : "";
    var apiKey = platform === "ios" ? cfg.revenueCatIosKey : cfg.revenueCatAndroidKey;
    if (!apiKey) return Promise.resolve();
    var configureOptions = { apiKey: apiKey };
    if (currentUserId) configureOptions.appUserID = currentUserId;
    try {
      var configureResult = RCPurchases.configure(configureOptions);
      if (!configureResult || typeof configureResult.then !== "function") {
        console.warn("[Unbroken] RCPurchases.configure did not return a promise — RevenueCat plugin API may differ from expected.");
        return Promise.resolve();
      }
      return configureResult.then(function () {
        return refreshCompanionAccess();
      }).catch(function (e) {
        console.warn("[Unbroken] RevenueCat configure failed:", e);
      });
    } catch (e) {
      console.warn("[Unbroken] RevenueCat configure threw synchronously:", e);
      return Promise.resolve();
    }
  }

  function refreshCompanionAccess() {
    if (!isNativeApp || !RCPurchases) return Promise.resolve(hasCompanionAccess);
    return RCPurchases.getCustomerInfo().then(function (result) {
      var info = result && result.customerInfo;
      hasCompanionAccess = !!(info && info.entitlements && info.entitlements.active && info.entitlements.active[COMPANION_ENTITLEMENT_ID]);
      return hasCompanionAccess;
    }).catch(function (e) {
      console.warn("[Unbroken] Could not refresh entitlement:", e);
      return hasCompanionAccess;
    });
  }

  // ---------- Local state ----------
  var todayKey = new Date().toISOString().slice(0, 10);

  function loadState() {
    return {
      startDate: localStorage.getItem("unbroken_start_date") || (function () {
        var d = new Date().toISOString().slice(0, 10);
        localStorage.setItem("unbroken_start_date", d);
        return d;
      })(),
      lastResetDate: localStorage.getItem("unbroken_last_reset_date"),
      longestStreak: parseInt(localStorage.getItem("unbroken_longest_streak") || "0", 10),
      urgesDate: localStorage.getItem("unbroken_urges_date"),
      urgesCount: parseInt(localStorage.getItem("unbroken_urges_count") || "0", 10),
      chatDate: localStorage.getItem("unbroken_chat_date"),
      chatCount: parseInt(localStorage.getItem("unbroken_chat_count") || "0", 10),
      totalUrges: parseInt(localStorage.getItem("unbroken_total_urges") || "0", 10),
      resetCount: parseInt(localStorage.getItem("unbroken_reset_count") || "0", 10),
      doneDates: JSON.parse(localStorage.getItem("unbroken_done_dates") || "[]")
    };
  }

  function daysBetween(dateStr, todayStr) {
    var a = new Date(dateStr + "T00:00:00");
    var b = new Date(todayStr + "T00:00:00");
    return Math.max(0, Math.round((b - a) / 86400000));
  }

  var state = loadState();

  // reset urge counter if it's a new day
  if (state.urgesDate !== todayKey) {
    state.urgesCount = 0;
    state.urgesDate = todayKey;
    localStorage.setItem("unbroken_urges_count", "0");
    localStorage.setItem("unbroken_urges_date", todayKey);
  }

  // reset chat counter if it's a new day
  if (state.chatDate !== todayKey) {
    state.chatCount = 0;
    state.chatDate = todayKey;
    localStorage.setItem("unbroken_chat_count", "0");
    localStorage.setItem("unbroken_chat_date", todayKey);
  }

  var DAILY_CHAT_LIMIT = 25;

  function computeStreak() {
    var base = state.lastResetDate || state.startDate;
    return daysBetween(base, todayKey);
  }

  function programDay() {
    return daysBetween(state.startDate, todayKey) + 1;
  }

  function syncStreakToServer(current, longest) {
    if (!supabase || !currentUserId) return;
    supabase.from("streaks").upsert({
      user_id: currentUserId,
      current_streak: current,
      longest_streak: longest,
      last_reset_at: state.lastResetDate ? state.lastResetDate + "T00:00:00Z" : null,
      updated_at: new Date().toISOString()
    }).then(function (res) {
      if (res.error) console.warn("Streak sync failed:", res.error.message);
    });
  }

  // ---------- Reframe content ----------
  var reframes = [];
  var maintenanceItems = [];
  function loadReframes() {
    return fetch("reframes.json").then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " " + r.statusText + " for reframes.json");
      return r.json();
    }).then(function (data) {
      reframes = data;
    }).catch(function (e) {
      console.warn("Could not load reframes:", e);
      var title = document.getElementById("reframeTitle");
      if (title) title.textContent = "Couldn't load today's lesson. Check your connection and reopen the app.";
    });
  }

  function loadMaintenance() {
    return fetch("maintenance.json").then(function (r) { return r.json(); }).then(function (data) {
      maintenanceItems = data;
    }).catch(function (e) {
      console.warn("Could not load maintenance content:", e);
    });
  }

  function pickReframe(day) {
    if (day > 30 && maintenanceItems.length) {
      var idx = (day - 31) % maintenanceItems.length;
      var m = maintenanceItems[idx];
      return { technique: m.technique, title: m.title, lesson: m.lesson, action: m.action };
    }
    if (!reframes.length) return null;
    var best = reframes[0];
    for (var i = 0; i < reframes.length; i++) {
      if (reframes[i].day <= day) best = reframes[i];
    }
    return best;
  }

  function renderToday() {
    var day = programDay();
    document.getElementById("dayPillText").textContent = day > 30 ? "Maintenance" : "Day " + day;
    var r = pickReframe(day);
    if (!r) return;
    document.getElementById("techniqueLabel").textContent = r.technique;
    document.getElementById("reframeTitle").textContent = r.title;
    document.getElementById("reframeLesson").textContent = r.lesson;
    document.getElementById("reframeAction").textContent = r.action;

    var context = document.getElementById("reframeContext");
    var streak = computeStreak();
    if (day <= 30 && (day - streak) >= 3) {
      context.textContent = "Program day " + day + ", but your current streak is " + streak + " days — those are different counts, and that's normal. The lesson still applies.";
      context.classList.remove("hidden");
    } else {
      context.classList.add("hidden");
    }

    renderPracticeBar(r);

    var doneBtn = document.getElementById("doneTodayBtn");
    if (state.doneDates.indexOf(todayKey) !== -1) {
      doneBtn.textContent = "Done for today";
      doneBtn.disabled = true;
    } else {
      doneBtn.textContent = "Mark done";
      doneBtn.disabled = false;
    }

    var notes = JSON.parse(localStorage.getItem("unbroken_today_notes") || "{}");
    var noteBox = document.getElementById("todayNote");
    if (noteBox) noteBox.value = notes[todayKey] ? notes[todayKey].text : "";
  }

  document.getElementById("doneTodayBtn").addEventListener("click", function () {
    if (state.doneDates.indexOf(todayKey) === -1) {
      state.doneDates.push(todayKey);
      localStorage.setItem("unbroken_done_dates", JSON.stringify(state.doneDates));
    }
    renderToday();
    maybeRequestReview(programDay());
  });

  document.getElementById("saveTodayNoteBtn").addEventListener("click", function () {
    var text = document.getElementById("todayNote").value.trim();
    if (!text) return;
    var title = document.getElementById("reframeTitle").textContent;

    var notes = JSON.parse(localStorage.getItem("unbroken_today_notes") || "{}");
    notes[todayKey] = { title: title, text: text, created_at: new Date().toISOString() };
    localStorage.setItem("unbroken_today_notes", JSON.stringify(notes));

    if (supabase && currentUserId) {
      supabase.from("journal_entries").insert({
        user_id: currentUserId, prompt: "Today's move — " + title, entry: text
      }).then(function (res) {
        if (res.error) console.warn("Today note sync failed:", res.error.message);
      });
    }

    var saved = document.getElementById("todayNoteSaved");
    saved.classList.remove("hidden");
    setTimeout(function () { saved.classList.add("hidden"); }, 2000);
  });

  var HOLD_MINUTES = 30;

  function getUrgeHold() {
    var raw = localStorage.getItem("unbroken_urge_hold");
    return raw ? JSON.parse(raw) : null;
  }

  function setUrgeHold(hold) {
    if (hold) localStorage.setItem("unbroken_urge_hold", JSON.stringify(hold));
    else localStorage.removeItem("unbroken_urge_hold");
  }

  function hideAllUrgeCards() {
    ["urgeClassifyCard", "urgeWriteCard", "urgeHoldingCard", "urgeRevisitCard"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.classList.add("hidden");
    });
  }

  function renderUrgeArea() {
    var hold = getUrgeHold();
    hideAllUrgeCards();
    if (!hold) return;

    var elapsedMin = (Date.now() - new Date(hold.created_at).getTime()) / 60000;
    if (elapsedMin >= HOLD_MINUTES) {
      document.getElementById("urgeDraftReadback").textContent = hold.text;
      document.getElementById("urgeRevisitCard").classList.remove("hidden");
    } else {
      var remaining = Math.ceil(HOLD_MINUTES - elapsedMin);
      document.getElementById("urgeHoldingText").textContent = "Held. Revisit in " + remaining + " minute" + (remaining === 1 ? "" : "s") + ".";
      document.getElementById("urgeHoldingCard").classList.remove("hidden");
    }
  }

  function yesterdayKey() {
    var d = new Date(todayKey + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  // Urges logged per day (date -> count), so the greeting can say what happened yesterday.
  function urgeDays() {
    try { return JSON.parse(localStorage.getItem("sobeit_urge_days") || "{}") || {}; } catch (e) { return {}; }
  }

  function logUrge(type) {
    var days = urgeDays();
    days[todayKey] = (days[todayKey] || 0) + 1;
    var keys = Object.keys(days).sort();
    while (keys.length > 60) { delete days[keys.shift()]; }
    try { localStorage.setItem("sobeit_urge_days", JSON.stringify(days)); } catch (e) {}
    state.urgesCount += 1;
    state.totalUrges += 1;
    localStorage.setItem("unbroken_urges_count", String(state.urgesCount));
    localStorage.setItem("unbroken_total_urges", String(state.totalUrges));
    document.getElementById("urgeCount").textContent = state.urgesCount;

    if (supabase && currentUserId) {
      supabase.from("urge_logs").insert({ user_id: currentUserId }).then(function (res) {
        if (res.error) console.warn("Urge log sync failed:", res.error.message);
      });
    }
  }

  document.getElementById("urgeBtn").addEventListener("click", function () {
    if (getUrgeHold()) { renderUrgeArea(); return; }
    hideAllUrgeCards();
    document.getElementById("urgeClassifyCard").classList.remove("hidden");
  });

  document.getElementById("urgeNecessaryBtn").addEventListener("click", function () {
    logUrge("necessary");
    hideAllUrgeCards();
  });

  document.getElementById("urgeEmotionalBtn").addEventListener("click", function () {
    logUrge("emotional");
    hideAllUrgeCards();
    document.getElementById("urgeWriteCard").classList.remove("hidden");
  });

  document.getElementById("startHoldBtn").addEventListener("click", function () {
    var text = document.getElementById("urgeDraftText").value.trim();
    if (!text) return;
    setUrgeHold({ text: text, created_at: new Date().toISOString() });
    document.getElementById("urgeDraftText").value = "";
    renderUrgeArea();
  });

  document.getElementById("gladWaitedBtn").addEventListener("click", function () {
    setUrgeHold(null);
    hideAllUrgeCards();
  });

  document.getElementById("stillWantBtn").addEventListener("click", function () {
    setUrgeHold(null);
    hideAllUrgeCards();
  });

  // ---------- Companion nudges: open the Companion with a first message ready ----------
  function openCompanionWith(text, where) {
    if (where) trackEvent("nudge_tap", where);
    showView("companion");
    var input = document.getElementById("chatInput");
    if (input && text && !input.value.trim()) input.value = text;
    autoGrowChatInput();
    updateChatStarters();
    if (input && !input.closest(".hidden")) { try { input.focus(); } catch (e) {} }
  }

  document.getElementById("holdTalkBtn").addEventListener("click", function () {
    var hold = getUrgeHold();
    openCompanionWith(hold && hold.text
      ? "I'm in the 30-minute hold and I still want to text my ex. This is what I wrote: \"" + hold.text.slice(0, 400) + "\""
      : "I'm in the 30-minute hold and I still want to text my ex.", "hold_wait");
  });

  document.getElementById("urgeTalkBtn").addEventListener("click", function () {
    var draft = document.getElementById("urgeDraftText").value.trim();
    hideAllUrgeCards();
    openCompanionWith(draft
      ? "I want to text my ex right now. This is what I want to send: \"" + draft.slice(0, 400) + "\""
      : "I want to text my ex right now.", "urge_write");
  });

  document.getElementById("revisitTalkBtn").addEventListener("click", function () {
    var hold = getUrgeHold();
    setUrgeHold(null);
    hideAllUrgeCards();
    openCompanionWith(hold && hold.text
      ? "I waited 30 minutes and I still want to send this to my ex: \"" + hold.text.slice(0, 400) + "\""
      : "I waited 30 minutes and I still want to text my ex.", "revisit");
  });

  setInterval(renderUrgeArea, 60000);

  // ---------- Tracker ----------
  function renderTracker() {
    var current = computeStreak();
    if (current > state.longestStreak) {
      state.longestStreak = current;
      localStorage.setItem("unbroken_longest_streak", String(current));
    }
    document.getElementById("streakNumber").textContent = current;
    document.getElementById("longestStreak").textContent = "Longest streak: " + state.longestStreak + " days";
    document.getElementById("urgeCount").textContent = state.urgesCount;
    syncStreakToServer(current, state.longestStreak);
    renderUrgeArea();
  }

  document.getElementById("resetBtn").addEventListener("click", function () {
    document.getElementById("resetClassifyCard").classList.remove("hidden");
  });

  document.getElementById("resetReasonGrid").addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-reason]");
    if (!btn) return;
    var reason = btn.getAttribute("data-reason");
    lastResetReason = reason;

    var reasons = JSON.parse(localStorage.getItem("unbroken_reset_reasons") || "[]");
    reasons.push({ reason: reason, created_at: new Date().toISOString() });
    localStorage.setItem("unbroken_reset_reasons", JSON.stringify(reasons));

    state.lastResetDate = todayKey;
    state.resetCount += 1;
    localStorage.setItem("unbroken_last_reset_date", todayKey);
    localStorage.setItem("unbroken_reset_count", String(state.resetCount));
    document.getElementById("resetClassifyCard").classList.add("hidden");
    document.getElementById("resetMessage").classList.remove("hidden");
    renderTracker();
  });

  var lastResetReason = "";
  document.getElementById("resetTalkBtn").addEventListener("click", function () {
    openCompanionWith("I reached out to my ex today" + (lastResetReason ? " (" + lastResetReason.toLowerCase() + ")" : "") + ". Help me look at what happened.", "reset");
  });

  // ---------- View from above ----------
  function computeJournalEntryCount() {
    var journal = JSON.parse(localStorage.getItem("unbroken_journal") || "[]");
    var recaps = JSON.parse(localStorage.getItem("unbroken_recaps") || "[]");
    var reviews = JSON.parse(localStorage.getItem("unbroken_reviews") || "[]");
    return journal.length + recaps.length + reviews.length;
  }

  function renderViewAbove() {
    document.getElementById("statDays").textContent = programDay();
    document.getElementById("statLongest").textContent = state.longestStreak;
    document.getElementById("statUrges").textContent = state.totalUrges;
    document.getElementById("statResets").textContent = state.resetCount;
    document.getElementById("statEntries").textContent = computeJournalEntryCount();

    var reasons = JSON.parse(localStorage.getItem("unbroken_reset_reasons") || "[]");
    var necessary = reasons.filter(function (r) { return r.reason === "Necessary" || r.reason === "Practical"; }).length;
    var emotional = reasons.filter(function (r) { return r.reason === "Emotional" || r.reason === "Reassurance-seeking" || r.reason === "Regretted"; }).length;
    document.getElementById("statNecessary").textContent = necessary;
    document.getElementById("statEmotionalContact").textContent = emotional;
  }

  document.getElementById("toggleAboveBtn").addEventListener("click", function () {
    var box = document.getElementById("viewAbove");
    var willShow = box.classList.contains("hidden");
    box.classList.toggle("hidden");
    if (willShow) renderViewAbove();
  });

  // ---------- Journal ----------
  function saveJournalEntry(prompt, text) {
    var entries = JSON.parse(localStorage.getItem("unbroken_journal") || "[]");
    entries.push({ prompt: prompt, entry: text, created_at: new Date().toISOString() });
    localStorage.setItem("unbroken_journal", JSON.stringify(entries));

    if (supabase && currentUserId) {
      supabase.from("journal_entries").insert({
        user_id: currentUserId, prompt: prompt, entry: text
      }).then(function (res) {
        if (res.error) console.warn("Journal sync failed:", res.error.message);
      });
    }
  }

  document.getElementById("saveJournalBtn").addEventListener("click", function () {
    var text = document.getElementById("journalEntry").value.trim();
    if (!text) return;
    var prompt = document.getElementById("journalPrompt").textContent;
    saveJournalEntry(prompt, text);

    document.getElementById("journalEntry").value = "";
    lastJournalText = text;
    document.getElementById("journalTalkCard").classList.remove("hidden");
    var saved = document.getElementById("journalSaved");
    saved.classList.remove("hidden");
    setTimeout(function () { saved.classList.add("hidden"); }, 2000);
  });

  var lastJournalText = "";
  document.getElementById("journalTalkBtn").addEventListener("click", function () {
    document.getElementById("journalTalkCard").classList.add("hidden");
    openCompanionWith(lastJournalText
      ? "I just wrote this in my journal: \"" + lastJournalText.slice(0, 500) + "\" What am I not seeing?"
      : "I just wrote in my journal and want to talk it through.", "journal");
  });

  document.getElementById("saveRecapBtn").addEventListener("click", function () {
    var win = document.getElementById("recapWin").value.trim();
    var wish = document.getElementById("recapWish").value.trim();
    if (!win && !wish) return;

    var recaps = JSON.parse(localStorage.getItem("unbroken_recaps") || "[]");
    var entry = { date: todayKey, win: win, wish: wish, created_at: new Date().toISOString() };
    recaps.push(entry);
    localStorage.setItem("unbroken_recaps", JSON.stringify(recaps));

    if (supabase && currentUserId) {
      if (win) {
        supabase.from("journal_entries").insert({
          user_id: currentUserId, prompt: "Evening recap — small win", entry: win
        }).then(function (res) { if (res.error) console.warn("Recap sync failed:", res.error.message); });
      }
      if (wish) {
        supabase.from("journal_entries").insert({
          user_id: currentUserId, prompt: "Evening recap — do differently", entry: wish
        }).then(function (res) { if (res.error) console.warn("Recap sync failed:", res.error.message); });
      }
    }

    document.getElementById("recapWin").value = "";
    document.getElementById("recapWish").value = "";
    var recapSaved = document.getElementById("recapSaved");
    recapSaved.classList.remove("hidden");
    setTimeout(function () { recapSaved.classList.add("hidden"); }, 2000);
  });

  // ---------- History (all past entries) ----------
  function collectAllEntries() {
    var journal = JSON.parse(localStorage.getItem("unbroken_journal") || "[]");
    var recaps = JSON.parse(localStorage.getItem("unbroken_recaps") || "[]");
    var reviews = JSON.parse(localStorage.getItem("unbroken_reviews") || "[]");
    var todayNotes = JSON.parse(localStorage.getItem("unbroken_today_notes") || "{}");

    var all = [];

    journal.forEach(function (e) {
      all.push({ label: "Journal — " + e.prompt, text: e.entry, date: e.created_at });
    });

    recaps.forEach(function (e) {
      if (e.win) all.push({ label: "Evening recap — small win", text: e.win, date: e.created_at });
      if (e.wish) all.push({ label: "Evening recap — would do differently", text: e.wish, date: e.created_at });
    });

    reviews.forEach(function (e) {
      all.push({ label: e.prompt, text: e.entry, date: e.created_at });
    });

    Object.keys(todayNotes).forEach(function (dateKey) {
      var n = todayNotes[dateKey];
      all.push({ label: "Today's move — " + n.title, text: n.text, date: n.created_at });
    });

    var lineEntries = JSON.parse(localStorage.getItem("unbroken_line_entries") || "[]");
    lineEntries.forEach(function (e) {
      all.push({ label: "The Line", text: e.text, date: e.created_at });
    });

    var sortEntries = JSON.parse(localStorage.getItem("unbroken_sort_entries") || "[]");
    sortEntries.forEach(function (e) {
      all.push({ label: "Fact, feeling, or story", text: e.text, date: e.created_at });
    });

    all.sort(function (a, b) { return new Date(b.date) - new Date(a.date); });
    return all;
  }

  function formatHistoryDate(iso) {
    try {
      var d = new Date(iso);
      return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    } catch (e) { return ""; }
  }

  function renderHistory() {
    var entries = collectAllEntries();
    var list = document.getElementById("historyList");
    var empty = document.getElementById("historyEmpty");
    list.innerHTML = "";

    if (!entries.length) {
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");

    entries.forEach(function (e) {
      var div = document.createElement("div");
      div.className = "history-entry";

      var label = document.createElement("p");
      label.className = "history-entry-label";
      label.textContent = e.label;

      var date = document.createElement("p");
      date.className = "history-entry-date";
      date.textContent = formatHistoryDate(e.date);

      var text = document.createElement("p");
      text.className = "history-entry-text";
      text.textContent = e.text;

      div.appendChild(label);
      div.appendChild(date);
      div.appendChild(text);
      list.appendChild(div);
    });
  }

  document.getElementById("toggleHistoryBtn").addEventListener("click", function () {
    var panel = document.getElementById("historyPanel");
    var willShow = panel.classList.contains("hidden");
    panel.classList.toggle("hidden");
    if (willShow) renderHistory();
  });

  document.getElementById("saveReviewBtn").addEventListener("click", function () {
    var fields = [
      { id: "reviewValued", prompt: "Relationship review — what I valued" },
      { id: "reviewCrossed", prompt: "Relationship review — what crossed a line" },
      { id: "reviewAllowed", prompt: "Relationship review — what I let go that I shouldn't have" },
      { id: "reviewCompromised", prompt: "Relationship review — where I compromised my standard" },
      { id: "reviewLine", prompt: "Relationship review — the line going forward" }
    ];

    var anySaved = false;
    var reviews = JSON.parse(localStorage.getItem("unbroken_reviews") || "[]");

    fields.forEach(function (f) {
      var el = document.getElementById(f.id);
      var val = el.value.trim();
      if (!val) return;
      anySaved = true;
      reviews.push({ prompt: f.prompt, entry: val, created_at: new Date().toISOString() });
      if (supabase && currentUserId) {
        supabase.from("journal_entries").insert({
          user_id: currentUserId, prompt: f.prompt, entry: val
        }).then(function (res) { if (res.error) console.warn("Review sync failed:", res.error.message); });
      }
      el.value = "";
    });

    if (!anySaved) return;
    localStorage.setItem("unbroken_reviews", JSON.stringify(reviews));

    var reviewSaved = document.getElementById("reviewSaved");
    reviewSaved.classList.remove("hidden");
    setTimeout(function () { reviewSaved.classList.add("hidden"); }, 2000);
  });

  // ---------- Onboarding ----------
  var disclaimerAccepted = localStorage.getItem("unbroken_disclaimer_accepted");
  var hasKids = localStorage.getItem("unbroken_has_kids");
  var hasCode = localStorage.getItem("unbroken_code");

  function hideAllOnboardSteps() {
    ["onboardStep0", "onboardStep1", "onboardStep2"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.classList.add("hidden");
    });
  }

  var onboardSeen = {};
  function trackOnboard(step) {
    if (onboardSeen[step]) return;
    onboardSeen[step] = true;
    trackEvent("onboard_step", step);
  }

  // The kids and code questions are asked from the second day on, not at first open.
  function laterStepsDue() {
    if (!disclaimerAccepted) return false;
    var d = new Date(disclaimerAccepted);
    return isNaN(d.getTime()) || d.toDateString() !== new Date().toDateString();
  }

  function showNextOnboardStep() {
    hideAllOnboardSteps();
    var due = laterStepsDue();
    if (!disclaimerAccepted) trackOnboard("disclaimer");
    else if (due && hasKids === null) trackOnboard("kids");
    else if (due && !hasCode) trackOnboard("code");
    else if (onboardSeen.disclaimer || onboardSeen.kids || onboardSeen.code) trackOnboard("done");
    if (!disclaimerAccepted) {
      document.getElementById("onboardOverlay").classList.remove("hidden");
      document.getElementById("onboardStep0").classList.remove("hidden");
      return;
    }
    if (due && hasKids === null) {
      document.getElementById("onboardOverlay").classList.remove("hidden");
      document.getElementById("onboardStep1").classList.remove("hidden");
      return;
    }
    if (due && !hasCode) {
      document.getElementById("onboardOverlay").classList.remove("hidden");
      document.getElementById("onboardStep2").classList.remove("hidden");
      return;
    }
    document.getElementById("onboardOverlay").classList.add("hidden");
  }

  showNextOnboardStep();

  document.getElementById("disclaimerCheckbox").addEventListener("change", function (e) {
    document.getElementById("disclaimerContinueBtn").disabled = !e.target.checked;
  });

  document.getElementById("disclaimerContinueBtn").addEventListener("click", function () {
    localStorage.setItem("unbroken_disclaimer_accepted", new Date().toISOString());
    disclaimerAccepted = localStorage.getItem("unbroken_disclaimer_accepted");
    showNextOnboardStep();
    // First open: land straight on the Companion, already asking a question.
    if (document.getElementById("onboardOverlay").classList.contains("hidden")) {
      showView("companion");
      trackEvent("first_landing", "companion");
    }
  });

  function answerOnboarding(val) {
    localStorage.setItem("unbroken_has_kids", val);
    hasKids = val;
    showNextOnboardStep();
    renderTriggers();
  }
  document.getElementById("onboardYesBtn").addEventListener("click", function () { answerOnboarding("yes"); });
  document.getElementById("onboardNoBtn").addEventListener("click", function () { answerOnboarding("no"); });

  document.getElementById("saveCodeBtn").addEventListener("click", function () {
    var checked = document.querySelectorAll("#codeOptions input:checked");
    var values = Array.prototype.map.call(checked, function (c) { return c.value; });
    if (!values.length) {
      trackEvent("onboard_code_empty", "");
      var hint = document.getElementById("codeHint");
      if (hint) hint.classList.remove("hidden");
      return;
    }
    localStorage.setItem("unbroken_code", JSON.stringify(values));
    hasCode = localStorage.getItem("unbroken_code");
    showNextOnboardStep();
  });

  // ---------- Right Now panel ----------
  var rightNowItems = [];
  function loadRightNow() {
    return fetch("right_now.json").then(function (r) { return r.json(); }).then(function (data) {
      rightNowItems = data;
    }).catch(function (e) {
      console.warn("Could not load right-now content:", e);
    });
  }

  function renderTriggers() {
    var groups = { urge: "triggerGridUrge", body: "triggerGridBody", practical: "triggerGridPractical", contact: "triggerGridContact", circle: "triggerGridCircle" };
    Object.keys(groups).forEach(function (g) {
      var container = document.getElementById(groups[g]);
      if (!container) return;
      container.innerHTML = "";
      rightNowItems.filter(function (item) { return item.group === g; }).filter(function (item) {
        if (item.id === "kids" && hasKids === "no") return false;
        return true;
      }).forEach(function (item) {
        var btn = document.createElement("button");
        btn.className = "trigger-btn" + (g === "practical" ? " practical" : "");
        btn.textContent = item.label;
        btn.addEventListener("click", function () { showRightNowResponse(item); });
        container.appendChild(btn);
      });
    });
  }

  var currentRightNowItem = null;
  document.getElementById("rightnowTalkBtn").addEventListener("click", function () {
    var label = currentRightNowItem && currentRightNowItem.label ? currentRightNowItem.label : "";
    openCompanionWith(label ? "Right now: " + label + ". It's still hard." : "It's still hard right now.", "rightnow");
  });

  function showRightNowResponse(item) {
    currentRightNowItem = item;
    document.getElementById("rightnowResponseText").textContent = item.response;
    document.getElementById("rightnowActionText").textContent = item.action;
    var box = document.getElementById("rightnowResponse");
    box.classList.remove("hidden");
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  document.getElementById("holdLineBtn").addEventListener("click", function () {
    var what = document.getElementById("lineWhat").value.trim();
    var control = document.getElementById("lineControl").value.trim();
    var action = document.getElementById("lineAction").value.trim();
    if (!what && !control && !action) return;

    var entry = "What happened: " + what + " | In my control: " + control + " | Tomorrow: " + action;
    var lines = JSON.parse(localStorage.getItem("unbroken_line_entries") || "[]");
    lines.push({ text: entry, created_at: new Date().toISOString() });
    localStorage.setItem("unbroken_line_entries", JSON.stringify(lines));

    if (supabase && currentUserId) {
      supabase.from("journal_entries").insert({
        user_id: currentUserId, prompt: "The Line", entry: entry
      }).then(function (res) { if (res.error) console.warn("Line sync failed:", res.error.message); });
    }

    document.getElementById("lineWhat").value = "";
    document.getElementById("lineControl").value = "";
    document.getElementById("lineAction").value = "";
    var saved = document.getElementById("lineSaved");
    saved.classList.remove("hidden");
    setTimeout(function () { saved.classList.add("hidden"); }, 2000);
  });

  document.getElementById("sortSaveBtn").addEventListener("click", function () {
    var fact = document.getElementById("sortFact").value.trim();
    var feeling = document.getElementById("sortFeeling").value.trim();
    var story = document.getElementById("sortStory").value.trim();
    if (!fact && !feeling && !story) return;

    var entry = "Fact: " + fact + " | Feeling: " + feeling + " | Story: " + story;
    var sorts = JSON.parse(localStorage.getItem("unbroken_sort_entries") || "[]");
    sorts.push({ text: entry, created_at: new Date().toISOString() });
    localStorage.setItem("unbroken_sort_entries", JSON.stringify(sorts));

    if (supabase && currentUserId) {
      supabase.from("journal_entries").insert({
        user_id: currentUserId, prompt: "Fact, feeling, or story", entry: entry
      }).then(function (res) { if (res.error) console.warn("Sort sync failed:", res.error.message); });
    }

    document.getElementById("sortFact").value = "";
    document.getElementById("sortFeeling").value = "";
    document.getElementById("sortStory").value = "";
    var sortSaved = document.getElementById("sortSaved");
    sortSaved.classList.remove("hidden");
    setTimeout(function () { sortSaved.classList.add("hidden"); }, 2000);
  });

  // ---------- Companion chat ----------
  // COMPANION_SYSTEM_PROMPT now lives server-side in the companion-chat Edge Function.
  // The client never supplies the system prompt — only conversation messages and
  // labeled-as-data dynamic context are sent; the server builds the authoritative prompt.

  var CRISIS_PATTERN = /\b(suicid\w*|kill(ing)? myself|end(ing)? my life|take my (own )?life|self.?harm\w*|hurt(ing)? myself|want to die|wanna die|better off dead|no reason to (live|go on)|not worth living|can'?t go on|how (can|do) i go on|don'?t want to (live|be here|exist)|life (has|had) no (meaning|point)|give up on (life|living)|end it all|no point in )\b/i;
  var CRISIS_MESSAGE = "That sounds like a lot to carry alone right now. Please reach out to a crisis line — you can find one for your country at findahelpline.com — or contact your local emergency number, or someone you trust, right now. I'll stay here with you, but this needs a real person today. Not eventually.";

  var chatHistory = [];

  function loadChatHistory() {
    if (!supabase || !currentUserId) return Promise.resolve();
    return supabase.from("chat_messages")
      .select("role, content, created_at")
      .eq("user_id", currentUserId)
      .order("created_at", { ascending: false })
      .limit(60)
      .then(function (res) {
        if (res.error || !res.data) return;
        var log = document.getElementById("chatLog");
        res.data.slice().reverse().forEach(function (row) {
          chatHistory.push({ role: row.role, content: row.content });
          if (log) {
            var cls = row.role === "user" ? "user" : "bot";
            appendBubble(row.content, cls);
          }
        });
      }).catch(function (e) {
        console.warn("Could not load chat history:", e);
      });
  }

  function saveChatMessage(role, content) {
    if (!supabase || !currentUserId) return;
    supabase.from("chat_messages").insert({
      user_id: currentUserId, role: role, content: content
    }).then(function (res) {
      if (res.error) console.warn("Chat save failed:", res.error.message);
    });
  }

  function buildDynamicContext() {
    var journal = JSON.parse(localStorage.getItem("unbroken_journal") || "[]");
    var recaps = JSON.parse(localStorage.getItem("unbroken_recaps") || "[]");
    var reviews = JSON.parse(localStorage.getItem("unbroken_reviews") || "[]");
    var code = JSON.parse(localStorage.getItem("unbroken_code") || "[]");
    return [
      "Current state of this user in the app, for your awareness only — do not recite this list back to them,",
      "use it to respond as someone who already knows where they are, the way a coach who has seen their log would:",
      "Program day: " + programDay() + ".",
      "Current no-contact streak: " + computeStreak() + " days. Longest streak so far: " + state.longestStreak + " days.",
      "Times they have reset the streak: " + state.resetCount + ".",
      "Urges logged today (not acted on): " + state.urgesCount + ". Total urges logged all-time: " + state.totalUrges + ".",
      "Journal and reflection entries written so far: " + (journal.length + recaps.length + reviews.length) + ".",
      code.length ? "Their personal code, in their own words: " + code.join(", ") + "." : "They have not set a personal code yet."
    ].join(" ");
  }

  var SAFETY_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

  function activateSafetyWindow() {
    localStorage.setItem("unbroken_safety_active_until", String(Date.now() + SAFETY_WINDOW_MS));
  }

  function isSafetyActive() {
    var until = parseInt(localStorage.getItem("unbroken_safety_active_until") || "0", 10);
    return Date.now() < until;
  }

  function logCompanionStage(stage) {
    console.log("[Unbroken] Companion stage:", stage);
    var stats = JSON.parse(localStorage.getItem("unbroken_companion_stage_stats") || "{}");
    stats[stage] = (stats[stage] || 0) + 1;
    localStorage.setItem("unbroken_companion_stage_stats", JSON.stringify(stats));
  }

  // Shown once, right after the user's first Companion message, while the reply is loading.
  // Fixed app text: free, not counted as a message, never sent to the AI or saved to chat history.
  function showCompanionIntroOnce() {
    try {
      if (localStorage.getItem("unbroken_companion_intro_shown") === "1") return;
      localStorage.setItem("unbroken_companion_intro_shown", "1");
    } catch (e) { return; }
    var log = document.getElementById("chatLog");
    if (!log) return;
    var lines = [
      "Not a chatbot that tells you what you want to hear. A clear voice for the moments you'd otherwise text them, spiral, or lie awake.",
      "It already knows your day, your streak and your code, and it remembers what you tell it. No starting over.",
      "It cuts through the story your head is telling you and brings you back to what's actually in your control.",
      "Give it facts (what happened, what was said, what you want to do) and it gives you something you can act on tonight.",
      "It's not therapy or a crisis service. If you're in danger, it points you to real help."
    ];
    lines.push("Your answer is coming below.");
    var div = document.createElement("div");
    div.className = "chat-bubble bot intro";
    var title = document.createElement("strong");
    title.textContent = "Your Companion";
    div.appendChild(title);
    lines.forEach(function (t) {
      var para = document.createElement("p");
      para.textContent = t;
      div.appendChild(para);
    });
    log.appendChild(div);
    scrollChatToEnd();
  }

  function scrollChatToEnd() {
    var scroller = document.getElementById("views");
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  function appendBubble(text, cls) {
    var log = document.getElementById("chatLog");
    if (!log) return;
    var div = document.createElement("div");
    div.className = "chat-bubble " + cls;
    div.textContent = text;
    log.appendChild(div);
    scrollChatToEnd();
    return div;
  }

  // ---------- In-chat cards (offer, urge, journal, 60-second reset) ----------
  function makeCard(cls, eyebrow, title, body) {
    var div = document.createElement("div");
    div.className = "chat-card " + (cls || "");
    if (eyebrow) { var e = document.createElement("p"); e.className = "chat-card-eyebrow"; e.textContent = eyebrow; div.appendChild(e); }
    if (title) { var t = document.createElement("p"); t.className = "chat-card-title"; t.textContent = title; div.appendChild(t); }
    if (body) { var b = document.createElement("p"); b.className = "chat-card-body"; b.textContent = body; div.appendChild(b); }
    return div;
  }

  function cardButton(card, label, primary, onClick) {
    var btn = document.createElement("button");
    btn.className = primary ? "btn-primary chat-card-btn" : "btn-ghost chat-card-btn";
    btn.textContent = label;
    btn.addEventListener("click", function () { onClick(btn); });
    card.appendChild(btn);
    return btn;
  }

  function cardLink(card, label, onClick) {
    var btn = document.createElement("button");
    btn.className = "link-btn chat-card-link";
    btn.textContent = label;
    btn.addEventListener("click", function () { onClick(btn); });
    card.appendChild(btn);
    return btn;
  }

  function addCard(card) {
    var log = document.getElementById("chatLog");
    if (!log) return;
    log.appendChild(card);
    scrollChatToEnd();
  }

  var offerShownThisSession = false;

  // Shown in the chat once the free messages are used: the offer itself, with a button that opens
  // the unlock screen, and a way to keep going for free (the journal).
  function appendUnlockOffer(reason) {
    offerShownThisSession = true;
    var card;
    if (IOS_SALES_OFF) {
      card = makeCard("offer", reason === "last_free" ? "That was your last free message" : "Your free messages are used", "Unlimited Companion is coming soon on iPhone.",
        "Your journal, tracker and daily practice stay free.");
    } else {
      card = makeCard("offer", reason === "last_free" ? "That was your last free message" : "Your free messages are used", "Keep talking it through.",
        "Unlock the Companion: $9.99, one time. No subscription. Your journal, tracker and daily practice stay free.");
      cardButton(card, "Unlock", true, function () {
        trackEvent("offer_tap", reason);
        showView("paywall");
      });
    }
    cardLink(card, "Write in the journal instead", function () {
      trackEvent("card_tap", "offer:journal");
      openJournalSheet("offer");
    });
    addCard(card);
    trackEvent("offer_shown", reason);
  }

  // Cards the Companion asks for (server tags, only for this client). Same card at most once every 3 replies.
  var lastCardShown = {};
  var assistantReplies = 0;
  function appendToolCard(kind) {
    if (lastCardShown[kind] !== undefined && assistantReplies - lastCardShown[kind] < 3) return;
    lastCardShown[kind] = assistantReplies;
    var card;
    if (kind === "URGE") {
      card = makeCard("tool", "The urge", "Log it instead of acting on it.", "Or write the message here, where it stays and nothing sends.");
      cardButton(card, "Log the urge", true, function (btn) {
        logUrge("emotional");
        trackEvent("card_tap", "urge:log");
        btn.disabled = true;
        btn.textContent = "Logged. " + state.urgesCount + " today.";
      });
      cardButton(card, "Write it here instead", false, function () {
        trackEvent("card_tap", "urge:write");
        openJournalSheet("urge_card");
      });
    } else if (kind === "JOURNAL") {
      card = makeCard("tool", "Journal", "Put it on paper. Here, not to them.", "");
      cardButton(card, "Open the journal", true, function () {
        trackEvent("card_tap", "journal:open");
        openJournalSheet("journal_card");
      });
    } else if (kind === "RESET") {
      card = makeCard("tool", "60-second reset", "Phone down. Feet on the floor.", "Breathe out slower than you breathe in. Let the urge rise and fall without doing anything about it.");
      cardButton(card, "Start 60 seconds", true, function (btn) {
        if (btn.disabled) return;
        trackEvent("card_tap", "reset:start");
        btn.disabled = true;
        var left = 60;
        btn.textContent = "0:60";
        var timer = setInterval(function () {
          left -= 1;
          btn.textContent = "0:" + (left < 10 ? "0" : "") + left;
          if (left <= 0) {
            clearInterval(timer);
            btn.textContent = "60 seconds done";
            trackEvent("card_tap", "reset:done");
            var after = document.createElement("p");
            after.className = "chat-card-body";
            after.textContent = "If it's still strong, tell me what's left of it.";
            card.appendChild(after);
            scrollChatToEnd();
          }
        }, 1000);
      });
    } else {
      return;
    }
    addCard(card);
    trackEvent("card_shown", kind.toLowerCase());
  }

  // ---------- Journal sheet (write it here, not to them) ----------
  var sheetSource = "";
  var SHEET_PROMPT = "Write it here. Not to them.";
  function openJournalSheet(source) {
    sheetSource = source || "";
    document.getElementById("sheetTalkBtn").classList.toggle("hidden", !canUseCompanion());
    document.getElementById("sheetBackdrop").classList.remove("hidden");
    document.getElementById("journalSheet").classList.remove("hidden");
    trackEvent("screen", "journal_sheet");
    setTimeout(function () { try { document.getElementById("sheetText").focus(); } catch (e) {} }, 50);
  }
  function closeJournalSheet() {
    document.getElementById("sheetBackdrop").classList.add("hidden");
    document.getElementById("journalSheet").classList.add("hidden");
  }
  function saveFromSheet(talk) {
    var box = document.getElementById("sheetText");
    var text = box.value.trim();
    if (!text) { box.focus(); return; }
    saveJournalEntry(SHEET_PROMPT, text);
    trackEvent("journal_saved", sheetSource + (talk ? ":talk" : ""));
    box.value = "";
    closeJournalSheet();
    if (talk && canUseCompanion()) {
      document.getElementById("chatInput").value = "I just wrote this in my journal: \"" + text.slice(0, 500) + "\"";
      sendChatMessage();
    } else {
      appendBubble("Saved in your journal. It stays here.", "bot note");
    }
  }
  document.getElementById("sheetSaveBtn").addEventListener("click", function () { saveFromSheet(false); });
  document.getElementById("sheetTalkBtn").addEventListener("click", function () { saveFromSheet(true); });
  document.getElementById("sheetCloseBtn").addEventListener("click", closeJournalSheet);
  document.getElementById("sheetBackdrop").addEventListener("click", closeJournalSheet);

  // Free messages used up: never pull the person out of the chat. A small server-side check
  // decides whether the message shows any risk (typos and indirect wording included).
  // Risk -> crisis message + safety window (they can keep talking). Otherwise, or if the
  // check fails -> a reply that still includes crisis help and how to unlock.
  function lockedMessage() {
    return "You've used your " + FREE_TRIAL_MESSAGES + " free Companion messages. If you're struggling right now, contact your local emergency number or find a crisis line at findahelpline.com." +
      (IOS_SALES_OFF ? " Unlimited Companion is coming soon on iPhone. Your journal, tracker and daily practice stay free." : "");
  }

  function handleLockedMessage(text) {
    trackEvent("locked_msg", "");
    var input = document.getElementById("chatInput");
    appendBubble(text, "user");
    input.value = "";
    appendBubble("\u2026", "bot");
    var log = document.getElementById("chatLog");
    var placeholder = log.lastChild;

    function showLocked() {
      placeholder.textContent = lockedMessage();
      placeholder.className = "chat-bubble bot";
      appendUnlockOffer("locked");
    }

    if (!currentAccessToken) { showLocked(); return; }

    fetch(cfg.supabaseUrl + "/functions/v1/companion-chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + currentAccessToken,
        "apikey": cfg.supabasePublishableKey
      },
      body: JSON.stringify({ mode: "safety_check", text: text })
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (data && data.risk === true) {
        activateSafetyWindow();
        saveChatMessage("user", text);
        chatHistory.push({ role: "user", content: text });
        placeholder.textContent = CRISIS_MESSAGE;
        placeholder.className = "chat-bubble crisis";
        chatHistory.push({ role: "assistant", content: CRISIS_MESSAGE });
        saveChatMessage("assistant", CRISIS_MESSAGE);
      } else {
        showLocked();
      }
    }).catch(function (e) {
      console.warn("[Unbroken] Safety check failed:", e);
      showLocked();
    });
  }

  function sendChatMessage() {
    var input = document.getElementById("chatInput");
    var text = input.value.trim();
    if (!text) return;

    var trialTestMode = /[?&]testmode=1\b/.test(window.location.search);
    if (!hasCompanionAccess && !isSafetyActive() && !trialTestMode && !CRISIS_PATTERN.test(text) && freeMessagesLeft() <= 0) {
      handleLockedMessage(text);
      return;
    }

    appendBubble(text, "user");
    input.value = "";
    autoGrowChatInput();
    trackEvent("msg_sent", hasCompanionAccess ? "unlocked" : ("free_" + (freeMessagesUsed() + 1)));

    if (CRISIS_PATTERN.test(text)) {
      activateSafetyWindow();
      saveChatMessage("user", text);
      chatHistory.push({ role: "user", content: text });
      appendBubble(CRISIS_MESSAGE, "crisis");
      chatHistory.push({ role: "assistant", content: CRISIS_MESSAGE });
      saveChatMessage("assistant", CRISIS_MESSAGE);
      return;
    }

    var inSafety = isSafetyActive();
    var testMode = /[?&]testmode=1\b/.test(window.location.search);
    var onTrial = !hasCompanionAccess && !inSafety && !testMode;

    if (!inSafety && !testMode && state.chatCount >= DAILY_CHAT_LIMIT) {
      appendBubble("You've reached today's Companion limit. Your journal, tools, and exercises are still available. The Companion resets tomorrow.", "bot");
      return;
    }

    saveChatMessage("user", text);
    if (!inSafety && !testMode) {
      state.chatCount += 1;
      localStorage.setItem("unbroken_chat_count", String(state.chatCount));
    }

    chatHistory.push({ role: "user", content: text });
    updateChatStarters();

    if (!currentAccessToken) {
      appendBubble("The companion couldn't connect right now. Try again in a moment.", "bot");
      return;
    }

    showCompanionIntroOnce();
    appendBubble("…", "bot");
    var log = document.getElementById("chatLog");
    var placeholder = log.lastChild;

    fetch(cfg.supabaseUrl + "/functions/v1/companion-chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + (currentAccessToken || cfg.supabasePublishableKey),
        "apikey": cfg.supabasePublishableKey
      },
      body: JSON.stringify({
        messages: chatHistory,
        dynamicContext: buildDynamicContext(),
        cards: true,
        lastFree: onTrial && freeMessagesLeft() === 1,
        platform: isNativeApp ? (window.Capacitor.getPlatform ? window.Capacitor.getPlatform() : "unknown") : "web"
      })
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (data && data.errorCode === "subscription_required") {
        hasCompanionAccess = false;
        placeholder.remove();
        showView("paywall");
        showPaywallMessage("Your Companion access isn't active. Unlock it below to continue.");
        return;
      }

      var reply = (data.content || []).map(function (b) { return b.text || ""; }).join("").trim();
      var gotReply = !!reply;
      if (!reply) {
        reply = "Something went wrong on my end. Try again in a moment.";
      }

      var stageMatch = reply.match(/^\[STAGE:(GUIDE|TEACH|QUESTION|HANDBACK|SAFETY)\]\s*\n?/i);
      if (stageMatch) {
        reply = reply.slice(stageMatch[0].length).trim();
        var stage = stageMatch[1].toUpperCase();
        logCompanionStage(stage);
        if (stage === "SAFETY") activateSafetyWindow();
      }

      reply = reply.replace(/\s*\[CARD:\s*[A-Z]+\s*\]\s*/gi, " ").trim();

      if (data.stop_reason === "max_tokens") {
        console.warn("[Unbroken] Response truncated by max_tokens — reply cut off mid-generation.");
        reply += " [cut off — ask again for the rest]";
      }

      if (gotReply) {
        chatHistory.push({ role: "assistant", content: reply });
        saveChatMessage("assistant", reply);
      }
      placeholder.textContent = reply;
      placeholder.className = "chat-bubble bot";
      scrollChatToEnd();

      if (gotReply) {
        assistantReplies += 1;
        var cards = (data && Array.isArray(data.cards)) ? data.cards : [];
        if (cards.length && !(stageMatch && stageMatch[1].toUpperCase() === "SAFETY")) appendToolCard(String(cards[0]).toUpperCase());
      }

      if (onTrial && gotReply) {
        useFreeMessage();
        if (freeMessagesLeft() === 0) {
          appendUnlockOffer("last_free");
          updateLockedInput();
        }
      }
    }).catch(function () {
      placeholder.textContent = "Couldn't reach the Companion right now. Check your connection and try again.";
      placeholder.className = "chat-bubble bot";
    });
  }

  var chatSendBtn = document.getElementById("chatSendBtn");
  if (chatSendBtn) chatSendBtn.addEventListener("click", sendChatMessage);
  var chatInputEl = document.getElementById("chatInput");
  if (chatInputEl) chatInputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
  });
  if (chatInputEl) chatInputEl.addEventListener("input", function () { autoGrowChatInput(); updateChatStarters(); });

  function autoGrowChatInput() {
    var el = document.getElementById("chatInput");
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight + 2, 140) + "px";
  }

  function updateChatStarters() {
    var box = document.getElementById("chatStarters");
    if (!box) return;
    var input = document.getElementById("chatInput");
    var hasUserMsg = chatHistory.some(function (m) { return m.role === "user"; });
    box.classList.toggle("hidden", hasUserMsg || !!(input && input.value.trim()));
  }

  Array.prototype.forEach.call(document.querySelectorAll(".chat-starter"), function (b, i) {
    b.addEventListener("click", function () {
      var input = document.getElementById("chatInput");
      input.value = b.textContent;
      trackEvent("starter_tap", String(i + 1));
      sendChatMessage();
    });
  });

  // ---------- Navigation: the Companion is home; everything else opens from the menu ----------
  var views = document.querySelectorAll(".view");
  var navItems = document.querySelectorAll(".drawer-item[data-target]");
  var currentView = "companion";

  function showView(name) {
    var visibleName = name;
    currentView = name;
    views.forEach(function (v) {
      v.classList.toggle("hidden", v.dataset.view !== visibleName);
    });
    navItems.forEach(function (t) {
      t.classList.toggle("active", t.dataset.target === name);
    });
    closeDrawer();
    var scroller = document.getElementById("views");
    trackEvent("screen", visibleName);
    if (visibleName === "paywall") { if (scroller) scroller.scrollTop = 0; preparePaywall(); trackEvent("paywall_view", name); }
    if (visibleName === "companion") { trackEvent("companion_view", ""); updateChatStarters(); updateLockedInput(); setTimeout(function () { autoGrowChatInput(); scrollChatToEnd(); }, 0); }
    else if (scroller) scroller.scrollTop = 0;
    var bar = document.getElementById("practiceBar");
    if (bar) bar.classList.toggle("hidden", visibleName !== "companion" || !practiceBarDue);
    if (visibleName === "tracker") renderTracker();
  }

  function updateLockedInput() {
    var input = document.getElementById("chatInput");
    if (!input) return;
    input.placeholder = canUseCompanion() ? "Say what's happening\u2026" : "Unlock to keep talking";
  }

  // ---------- Menu drawer ----------
  function openDrawer() {
    var day = programDay();
    var streak = computeStreak();
    document.getElementById("drawerStreakNum").textContent = streak;
    document.getElementById("drawerStreakSub").textContent = (streak === 1 ? "day" : "days") + " \u00b7 " + (day > 30 ? "Maintenance" : "Day " + day + " of 30");
    document.getElementById("drawerProgress").style.width = Math.min(100, Math.round(Math.min(day, 30) / 30 * 100)) + "%";
    document.getElementById("drawer").classList.add("open");
    document.getElementById("drawer").setAttribute("aria-hidden", "false");
    document.getElementById("drawerBackdrop").classList.remove("hidden");
    document.getElementById("menuBtn").setAttribute("aria-expanded", "true");
    trackEvent("menu_open", currentView);
  }
  function closeDrawer() {
    var d = document.getElementById("drawer");
    if (!d) return;
    d.classList.remove("open");
    d.setAttribute("aria-hidden", "true");
    document.getElementById("drawerBackdrop").classList.add("hidden");
    document.getElementById("menuBtn").setAttribute("aria-expanded", "false");
  }
  document.getElementById("menuBtn").addEventListener("click", openDrawer);
  document.getElementById("drawerBackdrop").addEventListener("click", closeDrawer);
  Array.prototype.forEach.call(document.querySelectorAll("[data-target]"), function (el) {
    el.addEventListener("click", function () { showView(el.dataset.target); });
  });
  document.getElementById("dayPill").addEventListener("click", function () { trackEvent("card_tap", "daypill"); showView("today"); });
  document.getElementById("drawerCrisis").addEventListener("click", function () { trackEvent("crisis_link", "menu"); });

  // ---------- Today's practice bar (above the chat, until done for today) ----------
  var practiceBarDue = false;
  function renderPracticeBar(r) {
    var bar = document.getElementById("practiceBar");
    if (!bar) return;
    var day = programDay();
    // Not on the very first visit: a new person starts by talking, not by a lesson.
    var talked = chatHistory.some(function (m) { return m.role === "user"; });
    practiceBarDue = !!r && state.doneDates.indexOf(todayKey) === -1 && (talked || day > 1);
    document.getElementById("practiceBarLabel").textContent = (day > 30 ? "Today" : "Day " + day) + " practice";
    document.getElementById("practiceBarTitle").textContent = r ? r.title : "";
    bar.classList.toggle("hidden", currentView !== "companion" || !practiceBarDue);
  }
  document.getElementById("practiceBar").addEventListener("click", function () {
    trackEvent("card_tap", "practice_bar");
    showView("today");
  });

  // On iPhone, if Apple returns no product (e.g. agreement still pending), show "Coming soon"
  // instead of an error. Once the product loads, the normal Unlock button works with no update.
  var paywallChecked = false;
  function preparePaywall() {
    var btn = document.getElementById("subscribeBtn");
    if (freeMessagesUsed() >= FREE_TRIAL_MESSAGES) {
      showPaywallMessage("You've used your " + FREE_TRIAL_MESSAGES + " free messages.");
    }
    if (btn && !isNativeApp) {
      // Web: no purchases here, point to the app instead.
      btn.textContent = "Get the app on Google Play";
      var restoreBtnWeb = document.getElementById("restorePurchasesBtn");
      if (restoreBtnWeb) restoreBtnWeb.classList.add("hidden");
      showPaywallMessage((freeMessagesUsed() >= FREE_TRIAL_MESSAGES ? "You've used your " + FREE_TRIAL_MESSAGES + " free messages. " : "") +
        "Unlimited Companion is available in the app. Your journal, tracker and daily practice stay free here.");
      return;
    }
    if (btn && IOS_SALES_OFF) {
      // iPhone sales not switched on yet: no price, no buy button, no restore.
      btn.disabled = true;
      btn.textContent = "Coming soon";
      var restoreBtnIos = document.getElementById("restorePurchasesBtn");
      if (restoreBtnIos) restoreBtnIos.classList.add("hidden");
      var titleEl = document.querySelector("#view-paywall .reframe-title");
      if (titleEl) titleEl.textContent = "Companion: coming soon";
      var priceEl = document.querySelector("#view-paywall .action-text");
      if (priceEl) priceEl.textContent = "Unlimited Companion access is coming soon on iPhone.";
      showPaywallMessage((freeMessagesUsed() >= FREE_TRIAL_MESSAGES ? "You've used your " + FREE_TRIAL_MESSAGES + " free messages. " : "") +
        "Your journal, tracker and daily practice stay free.");
      return;
    }
    if (!btn || !isNativeApp || !RCPurchases || paywallChecked) return;
    var platform = window.Capacitor.getPlatform ? window.Capacitor.getPlatform() : "";
    if (platform !== "ios") return;
    paywallChecked = true;
    try {
      var check = RCPurchases.getProducts({ productIdentifiers: [COMPANION_PRODUCT_ID], type: "NON_SUBSCRIPTION" });
      if (!check || typeof check.then !== "function") { paywallChecked = false; return; }
      check.then(function (res) {
        var products = (res && res.products) || [];
        if (!products.length) {
          btn.disabled = true;
          btn.textContent = "Coming soon";
          showPaywallMessage("Unlocking the Companion is coming soon on iPhone. Your journal, tracker and daily practice stay free.");
        }
      }).catch(function (e) {
        console.warn("[Unbroken] Paywall product check failed:", e);
        paywallChecked = false;
      });
    } catch (e) {
      console.warn("[Unbroken] Paywall product check threw:", e);
      paywallChecked = false;
    }
  }

  function showPaywallMessage(text) {
    var el = document.getElementById("paywallMessage");
    if (!el) return;
    el.textContent = text;
    el.classList.remove("hidden");
  }

  var subscribeBtn = document.getElementById("subscribeBtn");
  if (subscribeBtn) subscribeBtn.addEventListener("click", function () {
    if (IOS_SALES_OFF) return;
    if (!isNativeApp) {
      window.open(PLAY_STORE_URL, "_blank");
      return;
    }
    if (!RCPurchases) {
      var diag = "DEBUG — isNativeApp: " + isNativeApp +
        " | Capacitor exists: " + !!window.Capacitor +
        " | platform: " + (window.Capacitor && window.Capacitor.getPlatform ? window.Capacitor.getPlatform() : "?") +
        " | plugins: " + (window.Capacitor && window.Capacitor.Plugins ? Object.keys(window.Capacitor.Plugins).join(", ") : "none");
      console.warn("[Unbroken] Purchase unavailable:", diag);
      showPaywallMessage("Purchases only work in the installed app.");
      return;
    }
    subscribeBtn.disabled = true;
    trackEvent("purchase_tap", "");
    RCPurchases.getProducts({ productIdentifiers: [COMPANION_PRODUCT_ID], type: "NON_SUBSCRIPTION" }).then(function (res) {
      var products = (res && res.products) || [];
      if (!products.length) {
        var diag3 = "DEBUG — requested: " + COMPANION_PRODUCT_ID +
          " | raw result: " + JSON.stringify(res) +
          " | products.length: " + products.length;
        console.warn("[Unbroken] No products returned:", diag3);
        showPaywallMessage("Couldn't load the purchase right now. Try again in a moment.");
        subscribeBtn.disabled = false;
        return null;
      }
      return RCPurchases.purchaseStoreProduct({ product: products[0] });
    }).then(function (purchaseResult) {
      if (!purchaseResult) return;
      return refreshCompanionAccess();
    }).then(function () {
      subscribeBtn.disabled = false;
      if (hasCompanionAccess) { trackEvent("purchase_done", ""); showView("companion"); }
    }).catch(function (e) {
      subscribeBtn.disabled = false;
      if (e && e.userCancelled) return;
      console.warn("[Unbroken] Purchase failed:", e);
      showPaywallMessage("Something went wrong with the purchase. Try again.");
    });
  });

  var restorePurchasesBtn = document.getElementById("restorePurchasesBtn");
  if (restorePurchasesBtn) restorePurchasesBtn.addEventListener("click", function () {
    if (!isNativeApp || !RCPurchases) {
      var diag2 = "DEBUG — isNativeApp: " + isNativeApp +
        " | Capacitor exists: " + !!window.Capacitor +
        " | platform: " + (window.Capacitor && window.Capacitor.getPlatform ? window.Capacitor.getPlatform() : "?") +
        " | plugins: " + (window.Capacitor && window.Capacitor.Plugins ? Object.keys(window.Capacitor.Plugins).join(", ") : "none");
      console.warn("[Unbroken] Restore unavailable:", diag2);
      showPaywallMessage("Restore only works in the installed app.");
      return;
    }
    restorePurchasesBtn.disabled = true;
    RCPurchases.restorePurchases().then(function () {
      return refreshCompanionAccess();
    }).then(function () {
      restorePurchasesBtn.disabled = false;
      if (hasCompanionAccess) {
        showPaywallMessage("Restored — opening Companion.");
        setTimeout(function () { showView("companion"); }, 800);
      } else {
        showPaywallMessage("No active purchase found for this account.");
      }
    }).catch(function (e) {
      restorePurchasesBtn.disabled = false;
      console.warn("[Unbroken] Restore failed:", e);
      showPaywallMessage("Couldn't restore purchases. Try again.");
    });
  });

  // ---------- Open counter (works even if login fails) ----------
  var openLogged = false;

  function getDeviceId() {
    var id = null;
    try { id = localStorage.getItem("sobeit_device_id"); } catch (e) {}
    if (!id) {
      id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2));
      try { localStorage.setItem("sobeit_device_id", id); } catch (e) {}
    }
    return id;
  }

  function platformName() {
    return isNativeApp ? (window.Capacitor.getPlatform ? window.Capacitor.getPlatform() : "native") : "web";
  }

  // Firebase Analytics (Android only): lets Google Ads optimise for people who open and use the app.
  var FIREBASE_EVENT_MAP = { msg_sent: "companion_message", nudge_tap: "companion_nudge", starter_tap: "companion_starter",
    paywall_view: "paywall_view", offer_tap: "offer_tap", purchase_tap: "purchase_tap", purchase_done: "companion_unlock" };
  function firebaseLog(name, detail) {
    try {
      if (!isNativeApp || !window.Capacitor || !window.Capacitor.getPlatform || window.Capacitor.getPlatform() !== "android") return;
      var fa = window.Capacitor.Plugins && window.Capacitor.Plugins.FirebaseAnalytics;
      if (!fa) return;
      var fbName = FIREBASE_EVENT_MAP[name];
      if (name === "onboard_step" && detail === "done") fbName = "onboarding_complete";
      if (!fbName) return;
      var p = fa.logEvent({ name: fbName, params: { detail: String(detail || "").slice(0, 40), build: String(APP_BUILD) } });
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
  }

  // Counts taps only (which button, which screen). Never sends what anyone writes.
  function trackEvent(name, detail) {
    firebaseLog(name, detail);
    try {
      var cfgNow = cfg || window.UNBROKEN_CONFIG;
      if (!cfgNow || !cfgNow.supabaseUrl) return;
      var headers = { "Content-Type": "application/json", "apikey": cfgNow.supabasePublishableKey, "Prefer": "return=minimal" };
      if (currentAccessToken) headers["Authorization"] = "Bearer " + currentAccessToken;
      fetch(cfgNow.supabaseUrl + "/rest/v1/app_events", {
        method: "POST", headers: headers,
        body: JSON.stringify({ device_id: getDeviceId().slice(0, 64), event: String(name).slice(0, 40), detail: String(detail || "").slice(0, 80), build: APP_BUILD.slice(0, 16), platform: platformName() })
      }).catch(function () {});
    } catch (e) {}
  }

  function logAppOpen() {
    if (openLogged) return;
    openLogged = true;
    try {
      var deviceId = getDeviceId();
      var firstOpen = deviceWasNew;
      var tz = "";
      try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) {}
      var row = {
        device_id: deviceId.slice(0, 64),
        first_open: firstOpen,
        tz: tz.slice(0, 64),
        lang: (navigator.language || "").slice(0, 32),
        platform: platformName(),
        build: APP_BUILD.slice(0, 16),
        auth_status: String(authDebugInfo).slice(0, 120),
        user_id: currentUserId || null
      };
      var headers = { "Content-Type": "application/json", "apikey": cfg.supabasePublishableKey, "Prefer": "return=minimal" };
      if (currentAccessToken) headers["Authorization"] = "Bearer " + currentAccessToken;
      fetch(cfg.supabaseUrl + "/rest/v1/app_opens", { method: "POST", headers: headers, body: JSON.stringify(row) })
        .catch(function (e) { console.warn("[So Be It] open log failed:", e); });
    } catch (e) {
      console.warn("[So Be It] open log error:", e);
    }
  }
  setTimeout(logAppOpen, 10000);

  // ---------- Returning greeting: built only from what the app recorded, no AI, never invented ----------
  function journalEntriesOn(dateKey) {
    var n = 0;
    ["unbroken_journal", "unbroken_recaps", "unbroken_reviews", "unbroken_line_entries", "unbroken_sort_entries"].forEach(function (k) {
      try {
        (JSON.parse(localStorage.getItem(k) || "[]") || []).forEach(function (e) {
          if (e && typeof e.created_at === "string" && e.created_at.slice(0, 10) === dateKey) n += 1;
        });
      } catch (e) {}
    });
    try {
      var notes = JSON.parse(localStorage.getItem("unbroken_today_notes") || "{}") || {};
      if (notes[dateKey]) n += 1;
    } catch (e) {}
    return n;
  }

  function buildReturningGreeting() {
    var day = programDay();
    var streak = computeStreak();
    var y = yesterdayKey();
    var parts = [];
    parts.push(day > 30 ? "Day " + day + "." : "Day " + day + " of 30.");
    if (streak > 0) parts.push(streak + (streak === 1 ? " day" : " days") + " of no contact.");
    var urgesY = urgeDays()[y] || 0;
    if (urgesY > 0) {
      var heldY = state.lastResetDate !== y && state.lastResetDate !== todayKey;
      parts.push("Yesterday you logged " + urgesY + (urgesY === 1 ? " urge" : " urges") + (heldY ? " and the streak held." : "."));
    }
    if (journalEntriesOn(y) > 0) parts.push("You wrote in your journal yesterday.");
    var r = pickReframe(day);
    if (r && r.title && state.doneDates.indexOf(todayKey) === -1) parts.push("Today's practice: " + r.title + ".");
    parts.push("What's on your mind today?");
    return parts.join(" ");
  }

  // Runs once the chat history is on screen, so these lines always land at the end of the conversation.
  function afterChatReady() {
    var hasTalked = chatHistory.some(function (m) { return m.role === "user"; });
    // Greets only on the first open of a new day (not on every reopen the same day).
    var lastVisit = null;
    try { lastVisit = localStorage.getItem("sobeit_last_visit"); localStorage.setItem("sobeit_last_visit", todayKey); } catch (e) {}
    if (hasTalked && lastVisit !== todayKey) {
      appendBubble(buildReturningGreeting(), "bot greeting");
      trackEvent("greeting_shown", "day_" + programDay());
    }
    if (!hasCompanionAccess && !isSafetyActive()) {
      var left = freeMessagesLeft();
      if (left <= 0) {
        if (hasTalked && !offerShownThisSession) appendUnlockOffer("reopen");
      } else if (!trialNoticeShown) {
        trialNoticeShown = true;
        appendBubble(left === FREE_TRIAL_MESSAGES
          ? "You have " + left + " free messages to try the Companion."
          : left + " free message" + (left === 1 ? "" : "s") + " left.", "bot note");
      }
    }
    updateLockedInput();
    updateChatStarters();
    scrollChatToEnd();
  }

  // ---------- Boot ----------
  if (document.getElementById("onboardOverlay").classList.contains("hidden")) showView("companion");
  ensureAuth().then(function (uid) {
    logAppOpen();
    return uid;
  }).then(function () {
    return Promise.all([loadAppConfig(), loadReframes(), loadRightNow(), loadMaintenance(), loadChatHistory(), initRevenueCat()]);
  }).then(function () {
    renderToday();
    renderTracker();
    renderTriggers();
    afterChatReady();
  }).catch(function (e) {
    console.warn("Boot sequence failed:", e);
    renderToday();
    renderTracker();
    renderTriggers();
    afterChatReady();
  });

})();
