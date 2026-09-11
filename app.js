(function () {
  "use strict";

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

  function ensureAuth() {
    if (!supabase) { authDebugInfo = "supabase client is null (init failed or window.supabase/UNBROKEN_CONFIG missing)"; return Promise.resolve(null); }
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
    return fetch("reframes.json").then(function (r) { return r.json(); }).then(function (data) {
      reframes = data;
    }).catch(function (e) {
      console.warn("Could not load reframes:", e);
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
    document.getElementById("dayPill").textContent = day > 30 ? "Maintenance" : "Day " + day;
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

  function logUrge(type) {
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
  document.getElementById("saveJournalBtn").addEventListener("click", function () {
    var text = document.getElementById("journalEntry").value.trim();
    if (!text) return;
    var prompt = document.getElementById("journalPrompt").textContent;

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

    document.getElementById("journalEntry").value = "";
    var saved = document.getElementById("journalSaved");
    saved.classList.remove("hidden");
    setTimeout(function () { saved.classList.add("hidden"); }, 2000);
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

  function showNextOnboardStep() {
    hideAllOnboardSteps();
    if (!disclaimerAccepted) {
      document.getElementById("onboardOverlay").classList.remove("hidden");
      document.getElementById("onboardStep0").classList.remove("hidden");
      return;
    }
    if (hasKids === null) {
      document.getElementById("onboardOverlay").classList.remove("hidden");
      document.getElementById("onboardStep1").classList.remove("hidden");
      return;
    }
    if (!hasCode) {
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
    if (values.length) localStorage.setItem("unbroken_code", JSON.stringify(values));
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

  function showRightNowResponse(item) {
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

  var CRISIS_PATTERN = /\b(suicid|kill myself|end my life|self.?harm|hurt myself|want to die|no reason to live|point (in|of) living|not worth living|can'?t go on|give up on (life|living)|end it all|no point in )\b/i;
  var CRISIS_MESSAGE = "That sounds like a lot to carry alone right now. Please reach out to a crisis line — you can find one for your country at findahelpline.com — or contact your local emergency number, or someone you trust, right now. I'll stay here with you, but this needs a real person today. Not eventually.";

  var chatHistory = [];

  function loadChatHistory() {
    if (!supabase || !currentUserId) return Promise.resolve();
    return supabase.from("chat_messages")
      .select("role, content, created_at")
      .eq("user_id", currentUserId)
      .order("created_at", { ascending: true })
      .limit(60)
      .then(function (res) {
        if (res.error || !res.data) return;
        var log = document.getElementById("chatLog");
        res.data.forEach(function (row) {
          chatHistory.push({ role: row.role, content: row.content });
          if (log) {
            var cls = row.role === "user" ? "user" : "bot";
            appendBubble(row.content, cls);
          }
        });
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

  function appendBubble(text, cls) {
    var log = document.getElementById("chatLog");
    if (!log) return;
    var div = document.createElement("div");
    div.className = "chat-bubble " + cls;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function sendChatMessage() {
    var input = document.getElementById("chatInput");
    var text = input.value.trim();
    if (!text) return;

    appendBubble(text, "user");
    input.value = "";

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

    if (!currentAccessToken) {
      appendBubble("DEBUG — no session token. supabase: " + (supabase ? "loaded" : "NULL") + ", currentUserId: " + (currentUserId || "none") + ", authDebugInfo: " + authDebugInfo, "bot");
      return;
    }

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
        dynamicContext: buildDynamicContext()
      })
    }).then(function (r) { return r.json(); }).then(function (data) {
      var reply = (data.content || []).map(function (b) { return b.text || ""; }).join("").trim();
      if (!reply) {
        reply = (data && data.error)
          ? "DEBUG — server said: " + data.error
          : "DEBUG — no content and no error field in response: " + JSON.stringify(data);
      }

      var stageMatch = reply.match(/^\[STAGE:(GUIDE|TEACH|QUESTION|HANDBACK|SAFETY)\]\s*\n?/i);
      if (stageMatch) {
        reply = reply.slice(stageMatch[0].length).trim();
        var stage = stageMatch[1].toUpperCase();
        logCompanionStage(stage);
        if (stage === "SAFETY") activateSafetyWindow();
      }

      if (data.stop_reason === "max_tokens") {
        console.warn("[Unbroken] Response truncated by max_tokens — reply cut off mid-generation.");
        reply += " [cut off — ask again for the rest]";
      }

      chatHistory.push({ role: "assistant", content: reply });
      saveChatMessage("assistant", reply);
      placeholder.textContent = reply;
      placeholder.className = "chat-bubble bot";
    }).catch(function () {
      placeholder.textContent = "Couldn't reach the companion right now. This demo version needs a live connection — in the real app this runs through a secure backend.";
      placeholder.className = "chat-bubble bot";
    });
  }

  var chatSendBtn = document.getElementById("chatSendBtn");
  if (chatSendBtn) chatSendBtn.addEventListener("click", sendChatMessage);
  var chatInputEl = document.getElementById("chatInput");
  if (chatInputEl) chatInputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter") sendChatMessage();
  });

  // ---------- Tab navigation ----------
  var tabs = document.querySelectorAll(".tab");
  var views = document.querySelectorAll(".view");

  function showView(name) {
    views.forEach(function (v) {
      v.classList.toggle("hidden", v.dataset.view !== name);
    });
    tabs.forEach(function (t) {
      t.classList.toggle("active", t.dataset.target === name);
    });
  }

  tabs.forEach(function (t) {
    t.addEventListener("click", function () {
      showView(t.dataset.target);
    });
  });

  // ---------- Boot ----------
  ensureAuth().then(function () {
    return Promise.all([loadReframes(), loadRightNow(), loadMaintenance(), loadChatHistory()]);
  }).then(function () {
    renderToday();
    renderTracker();
    renderTriggers();
  });

})();
