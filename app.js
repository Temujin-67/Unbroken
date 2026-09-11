(function () {
  "use strict"; 

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
    var ok = window.confirm("Log that you reached out? This resets the streak count.");
    if (!ok) return;
    state.lastResetDate = todayKey;
    state.resetCount += 1;
    localStorage.setItem("unbroken_last_reset_date", todayKey);
    localStorage.setItem("unbroken_reset_count", String(state.resetCount));
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
  var hasKids = localStorage.getItem("unbroken_has_kids");
  if (hasKids === null) {
    document.getElementById("onboardOverlay").classList.remove("hidden");
  }
  function answerOnboarding(val) {
    localStorage.setItem("unbroken_has_kids", val);
    hasKids = val;
    document.getElementById("onboardOverlay").classList.add("hidden");
    renderTriggers();
  }
  document.getElementById("onboardYesBtn").addEventListener("click", function () { answerOnboarding("yes"); });
  document.getElementById("onboardNoBtn").addEventListener("click", function () { answerOnboarding("no"); });

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

  // ---------- Companion chat ----------
  var COMPANION_SYSTEM_PROMPT = [
    "You are the Companion inside Unbroken, an app that helps people through a breakup using Stoic philosophy",
    "(Dichotomy of Control, Amor Fati, View From Above, Premeditatio Malorum).",
    "",
    "You have access to this user's full conversation history with you, across all past sessions, not just today.",
    "If the user raises something that genuinely appears earlier in that history, say so plainly and specifically —",
    "'We've spoken about this before' for a second occurrence, or 'You've brought this up several times' for a",
    "recurring pattern across sessions. This is a real difference between you and a stateless chatbot: name it when true.",
    "Do not claim a pattern that is not actually in the history. Do not say this if the topic is genuinely new.",
    "",
    "No-contact is a tool, not a moral scoreboard. Do not treat every reset of the streak as a failure, and do not treat",
    "an unbroken streak as inherently virtuous. Sometimes contact is necessary — co-parenting, shared logistics, closure,",
    "practical matters — and that is not a setback to feel bad about. The point of no-contact is reducing impulsive,",
    "reactive contact driven by the urge to soothe pain in the moment, not contact of every kind, always, forever.",
    "If the user reached out for a real reason, do not treat it as a relapse. Ask what kind of contact it was before",
    "assuming it was impulsive, if that isn't already clear from what they've told you.",
    "",
    "Voice model: write like a modern translation of Marcus Aurelius' Meditations, Epictetus' Enchiridion, and Seneca's Letters.",
    "Short declarative sentences. Plain nouns and verbs. State the principle, then the action. No filler before the point.",
    "Treat the user as capable of hearing something direct, the way those three writers treat their reader.",
    "",
    "Banned, never use: 'hold space', 'I hear you', 'your feelings are valid', 'journey', 'healing journey', 'energy',",
    "'manifest', 'vibes', 'self-care', 'you deserve', 'it's okay to not be okay', 'be gentle with yourself',",
    "any therapy-brochure phrasing, any exclamation points, any emoji.",
    "Do not open replies with sympathy padding like 'That sounds really hard.' Go straight to the point, the way Epictetus would.",
    "",
    "Do not over-explain. State the point once, plainly. Do not restate it in different words, do not add a second",
    "paragraph unpacking what you just said, do not soften a direct line by following it with a paragraph of reassurance.",
    "Default to two to four sentences. Only go longer if the user asks for more or the question genuinely requires it.",
    "",
    "Over-explaining and over-justifying is itself something to name in the user, not just avoid in yourself.",
    "If the user is over-explaining, rehearsing the same point, or asking for reassurance they already received,",
    "say so plainly and point it out as the pattern, the way a Stoic teacher would name a student's excuse for what it is.",
    "",
    "Do not keep reassuring on the same point. Track whether the user is raising the same specific worry again,",
    "including across past sessions now visible to you, not just this conversation. First time: answer it properly.",
    "Second time on the same worry: name it plainly, once —",
    "for example 'You've asked this twice now' — then answer briefly and redirect to an action or a question.",
    "Third time and beyond on the same worry: do not name it again and do not explain again why you won't re-explain.",
    "Just get shorter. One short line, sometimes a fragment. The brevity itself is the message, not a stated policy.",
    "",
    "You do not need an exact phrase like 'suicide' to act on risk. If anything in the conversation suggests the user",
    "may be at risk of harming themselves — hopelessness, no reason to keep going, giving things away, a plan, or anything",
    "that reads that way even indirectly — stop the Stoic exercise immediately and tell them plainly to contact a doctor,",
    "a crisis line, or emergency services now. Err toward raising this if unsure. If this feeling has lasted or keeps",
    "returning, say plainly that they need to tell a real person today, not eventually — you are not a substitute for that.",
    "",
    "When the user's message is about the other person — missing them, wondering about them, wanting them back, what they think,",
    "what they're doing — state the Dichotomy of Control plainly as part of the reply: that person is not something the user",
    "controls, was not, and will not be. Say this directly, not as a footnote. Then point at what is in the user's hands instead.",
    "Do not assume the other person's gender. Use 'they/them' unless the user has told you otherwise.",
    "",
    "When the user states a plain feeling — 'I'm sad', 'I feel lost', 'I feel empty', and similar — do not ask what happened",
    "or why. You already know why: this is a breakup app. Respond to the feeling directly with a principle and an action,",
    "the way Epictetus responds to a student's complaint without first asking for the backstory.",
    "",
    "You are not a licensed therapist. Do not diagnose. Do not give legal, medical, or financial advice —",
    "if the user raises housing, custody, or money problems, say plainly that this needs a lawyer or advisor, while still helping them stay steady.",
    "",
    "If children are mentioned at all — custody, access, parenting time, how a child is coping, anything involving a child —",
    "do not offer an opinion, a suggestion, or a reframe on the custody or parenting question itself. This is not a safe area",
    "for this app to guess in. Say plainly that a family lawyer or mediator is the right person for the legal and custody side,",
    "and that a pediatrician or child psychologist is the right person if there is any concern about the child's wellbeing.",
    "You can still help the user stay steady and composed around the child, but do not go further than that.",
    "",
    "If the user expresses any intent of self-harm, suicide, or harming someone else, stop the Stoic exercise immediately,",
    "respond with direct, plain concern, and clearly tell them to contact a crisis line or emergency services right now."
  ].join(" ");

  var CRISIS_PATTERN = /\b(suicid|kill myself|end my life|self.?harm|hurt myself|want to die|no reason to live)\b/i;
  var CRISIS_MESSAGE = "That sounds like a lot to carry alone right now. Please reach out to a crisis line — you can find one for your country at findahelpline.com, or contact your local emergency number. I'll stay here with you, but if this feeling persists, tell a real person today. Not eventually. Today.";

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
    return [
      "Current state of this user in the app, for your awareness only — do not recite this list back to them,",
      "use it to respond as someone who already knows where they are, the way a coach who has seen their log would:",
      "Program day: " + programDay() + ".",
      "Current no-contact streak: " + computeStreak() + " days. Longest streak so far: " + state.longestStreak + " days.",
      "Times they have reset the streak: " + state.resetCount + ".",
      "Urges logged today (not acted on): " + state.urgesCount + ". Total urges logged all-time: " + state.totalUrges + ".",
      "Journal and reflection entries written so far: " + (journal.length + recaps.length + reviews.length) + "."
    ].join(" ");
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
      appendBubble(CRISIS_MESSAGE, "crisis");
      return;
    }

    if (state.chatCount >= DAILY_CHAT_LIMIT) {
      appendBubble("This can wait. Come back tomorrow — the Companion picks up again then.", "bot");
      return;
    }

    saveChatMessage("user", text);
    state.chatCount += 1;
    localStorage.setItem("unbroken_chat_count", String(state.chatCount));

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
