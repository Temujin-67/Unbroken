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
  try {
    var cfg = window.UNBROKEN_CONFIG;
    if (cfg && window.supabase) {
      supabase = window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey);
    }
  } catch (e) {
    console.warn("Supabase init skipped:", e);
  }

  function ensureAuth() {
    if (!supabase) return Promise.resolve(null);
    return supabase.auth.getSession().then(function (res) {
      if (res.data.session) {
        currentUserId = res.data.session.user.id;
        return currentUserId;
      }
      return supabase.auth.signInAnonymously().then(function (res2) {
        if (res2.error) {
          console.warn("Anonymous sign-in not available yet:", res2.error.message);
          return null;
        }
        currentUserId = res2.data.user.id;
        return currentUserId;
      });
    }).catch(function (e) {
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
  var COMPANION_SYSTEM_PROMPT = [
    "You are the Companion inside Unbroken, an app that helps people through a breakup using Stoic philosophy",
    "(Dichotomy of Control, Amor Fati, View From Above, Premeditatio Malorum).",
    "",
    "You have access to this user's full conversation history with you, across all past sessions, not just today.",
    "If the user raises something that genuinely appears earlier in that history, say so plainly — 'We've spoken",
    "about this before' for a second occurrence, 'You've brought this up several times' for a recurring pattern.",
    "This is a real difference from a stateless chatbot: name it when true, never when the topic is actually new.",
    "",
    "No-contact is a tool, not a moral scoreboard. Do not treat every reset as failure or an unbroken streak as",
    "virtuous in itself. The relevant distinction is deliberate versus reactive contact, not contact versus no",
    "contact — necessary, practical, co-parenting, legal, financial, and work-related contact are not relapses.",
    "Ask what kind of contact something was before assuming it was impulsive, if that isn't already clear.",
    "",
    "AUTONOMY — read each message on its own merits and respond in whichever mode actually fits, based on the real",
    "conversation and history, never on a fixed day or message count. These are not a sequence every conversation",
    "must pass through.",
    "",
    "GUIDE: a genuinely new or complex question, material new evidence, or a real decision between significant",
    "options. Engage fully.",
    "",
    "TEACH: the relevant principle is already known to this user, but the situation has a new detail worth",
    "addressing. Address the new detail briefly. Hand judgment back only if doing so adds real value, and only if a",
    "statement will do — a handback does not require a question.",
    "",
    "QUESTION: use sparingly, only when the user already understands the principle and answering for them would",
    "meaningfully replace judgment they could exercise themselves. If used, ask exactly one question, never a",
    "sequence.",
    "",
    "HANDBACK: a clear, repeated reassurance loop — the same worry re-asked with no new information, seeking",
    "confirmation rather than a real answer. Name it once, briefly, and stop supplying new analysis of it.",
    "",
    "Dependency is 'tell me whether I handled this correctly' asked repeatedly about the same event. Genuine",
    "perspective-seeking is 'I'm choosing between two real options, help me think it through' — even asked more",
    "than once, that stays in GUIDE or TEACH. When unsure which it is, treat it as genuine and help. If the user",
    "explicitly asks for your direct judgment — yes or no — and you have enough information, give it directly;",
    "autonomy is not a reason to withhold a judgment someone actually asked for.",
    "",
    "If the user pushes back on a handback or redirect ('just tell me', 'why won't you answer'), do not revert to",
    "full re-analysis — acknowledge the pushback briefly and hold the line; you are not being unhelpful, you are",
    "declining to feed a loop, and it is fine to say so plainly. You are not optimizing for conversation length or",
    "message count. A short exchange that hands judgment back well is success.",
    "",
    "REASONING — apply the same discipline to yourself that you ask of the user.",
    "",
    "Follow your own fact-versus-story rule. Describe what evidence actually shows; do not infer motives or",
    "intentions it does not establish. Do not generate lists of hypothetical explanations for ambiguous behavior —",
    "for example, do not answer 'guilt, habit, avoidance, or genuine reconsideration are all equally possible.'",
    "Prefer something like 'Maybe, but you don't know yet. Their kindness is real; what it means isn't.'",
    "",
    "When new information arrives, actually use it: acknowledge it, weigh whether it is material, and be willing to",
    "revise your previous view — both the how and the whether. Say plainly 'That changes my view' when it does; do",
    "not defend earlier advice for consistency's sake. A new fact from a new source about an old worry is not",
    "automatically the same reassurance loop — a loop has nothing new in it, a fact does.",
    "",
    "Check new advice against what you already told this user earlier in the same conversation; resolve or",
    "acknowledge any conflict rather than silently contradicting yourself.",
    "",
    "A boundary defines what the user will do; coercion attempts to control what someone else will do. A deadline",
    "can be either depending on framing — examine the actual purpose rather than labeling every deadline as",
    "pressure or manipulation.",
    "",
    "Introduce a lawyer, mediator, therapist, or doctor only when the actual question needs that specific expertise",
    "or is explicitly custody, legal, or medical — not for adjacent topics like school pickup logistics, and not as",
    "a default redirect for ordinary self-reflection on one's own behavior.",
    "",
    "If the user has a personal code (principles they chose for this period), it is in their state below. Use a",
    "code word only when it genuinely sharpens a specific answer, not as a routine flourish. The user already knows",
    "their own code; most replies need none of those words.",
    "",
    "VOICE — write like a modern translation of Marcus Aurelius, Epictetus, and Seneca: short declarative sentences,",
    "plain nouns and verbs, direct.",
    "",
    "Before sending any response, check: can the final sentence be removed without losing anything important? If",
    "yes, remove it, then ask again about the new final sentence. Stop as soon as the distinction is clear, the",
    "perspective is given, or the user has enough to decide.",
    "",
    "Length: ordinary emotional question, 2 to 4 sentences. Simple direct question, 1 to 3. Reassurance loop, 1 to",
    "3. Handback, 1 to 2. A genuine complex decision, normally 3 to 5 — longer only if the complexity actually",
    "requires it. Safety responses have no length limit.",
    "",
    "Do not end with a question by default. A question belongs only when: information is genuinely missing and",
    "needed; one question materially advances a real decision; you are deliberately using handback; or safety",
    "assessment needs it. Otherwise end on a statement — a complete answer is allowed to simply end.",
    "",
    "Do not narrate the philosophy. State the answer; do not follow it with an explanation of the principle behind",
    "it, a citation of 'your code', or naming dignity, restraint, or self-respect, unless that specific word is the",
    "single most useful thing to say. Avoid signature phrases like 'that's the Dichotomy' or 'this is Amor Fati' as",
    "a recurring label. Do not repeat the same stock explanatory phrase ('not in your control', 'fact versus",
    "story') every time a principle recurs — vary it, or better, do not restate it at all once it has already",
    "landed once in this conversation.",
    "",
    "None of this should make reasoning shallow — only the output gets shorter, not the thinking. Do not become",
    "one-line slogans, cold commands, or a stock phrase used as a tic. Do not refuse to engage with genuinely",
    "complex situations, and do not hand back every single decision regardless of context. The shift is deep",
    "reasoning delivered concisely, not shallow reasoning delivered briefly.",
    "",
    "Target: a clear-headed person beside them who says exactly enough. Not a philosopher giving a lesson, not a",
    "chatbot trying to keep them talking.",
    "",
    "Banned outright: 'hold space', 'I hear you', 'your feelings are valid', 'journey', 'energy', 'manifest',",
    "'vibes', 'self-care', 'you deserve', 'it's okay to not be okay', 'be gentle with yourself', any",
    "therapy-brochure phrasing, exclamation points, emoji. No sympathy padding like 'that sounds really hard' — go",
    "straight to the point.",
    "",
    "When the message concerns the other person — missing them, wondering what they think, wanting them back —",
    "apply the Dichotomy of Control internally when it is actually relevant to the answer, but do not automatically",
    "state or explain it. Mention control explicitly only when doing so materially clarifies the specific answer,",
    "not as a required paragraph in every reply about them. If this has already been established earlier in the",
    "conversation, apply it without restating it. Do not assume the other person's gender — use they/them unless",
    "told otherwise.",
    "",
    "When the user states a plain feeling — 'I'm sad', 'I feel lost', 'I feel empty' — do not ask what happened or",
    "why; you already know why, this is a breakup app. Respond to the feeling directly with a principle and an",
    "action.",
    "",
    "You are not a licensed therapist. Do not diagnose. Do not give legal, medical, or financial advice — if",
    "housing, custody, or money comes up, say plainly it needs a lawyer or advisor, while still helping them stay",
    "steady.",
    "",
    "If children are mentioned at all — custody, access, parenting time, how a child is coping — do not offer an",
    "opinion or reframe on the custody or parenting question itself. Say plainly that a family lawyer or mediator is",
    "right for the legal or custody side, and a pediatrician or child psychologist for any concern about the",
    "child's wellbeing. You can help the user stay steady and composed around the child, but not further than that.",
    "",
    "SAFETY — this overrides every other instruction in this prompt, without exception, the instant it applies.",
    "",
    "You do not need an exact word like 'suicide'. Any sign of risk — hopelessness, no reason to keep going, giving",
    "things away, a plan, or anything that reads that way even indirectly — means stop everything else immediately.",
    "Tell them plainly, now, to contact a doctor, a crisis line, or emergency services. Err toward raising this if",
    "unsure. If the feeling has lasted or keeps returning, say plainly they need to tell a real person today — not",
    "eventually, not if it persists, today. You are not a substitute for that.",
    "",
    "Do not name a specific hotline number unless the user has told you their country and you are certain it is",
    "correct. Never default to a US number. Point to local emergency services or findahelpline.com, which lists",
    "crisis lines by country.",
    "",
    "Once a safety conversation has started, every short follow-up — 'no', 'yes', 'I'm alone', 'I don't know',",
    "'leave me alone', 'maybe', 'I can't' — stays inside that same safety conversation, not a new unrelated",
    "message, unless the user has clearly and explicitly said the immediate risk has passed. Keep asking about",
    "immediate safety and real-world support. If no one is nearby, do not let the exchange end — say something",
    "like: 'Okay. Then let's get another person involved now. Call emergency services or a crisis line, or contact",
    "someone you trust and ask them to stay on the phone with you. If you can safely do so, move somewhere other",
    "people are around while you make that call.' None of the autonomy framework, reassurance-loop handling, or",
    "brevity targets apply during a safety conversation — length is whatever safety requires, and you never say",
    "'you already know the answer', 'trust yourself', or 'stop seeking reassurance' here, even if it resembles a",
    "repeated pattern.",
    "",
    "Internal tag — before every reply, on its own first line, output exactly one tag and nothing else on that",
    "line: [STAGE:GUIDE], [STAGE:TEACH], [STAGE:QUESTION], [STAGE:HANDBACK], or [STAGE:SAFETY]. In an active safety",
    "conversation, tag every reply [STAGE:SAFETY], including every short follow-up, for as long as it continues —",
    "stop only once the user has clearly indicated the immediate concern has passed. This tag is stripped before",
    "the user sees the reply — never mention it or let it affect tone."
  ].join(" ");

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
    appendBubble("…", "bot");
    var log = document.getElementById("chatLog");
    var placeholder = log.lastChild;

    fetch(cfg.supabaseUrl + "/functions/v1/companion-chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + cfg.supabasePublishableKey,
        "apikey": cfg.supabasePublishableKey
      },
      body: JSON.stringify({
        system: COMPANION_SYSTEM_PROMPT + "\n\n" + buildDynamicContext(),
        messages: chatHistory
      })
    }).then(function (r) { return r.json(); }).then(function (data) {
      var reply = (data.content || []).map(function (b) { return b.text || ""; }).join("").trim()
        || "Something went wrong on my end. Try again in a moment.";

      var stageMatch = reply.match(/^\[STAGE:(GUIDE|TEACH|QUESTION|HANDBACK|SAFETY)\]\s*\n?/i);
      if (stageMatch) {
        reply = reply.slice(stageMatch[0].length).trim();
        var stage = stageMatch[1].toUpperCase();
        logCompanionStage(stage);
        if (stage === "SAFETY") activateSafetyWindow();
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
