// ============================================================
// app.js
// ClassTrack – Student Portal
// Single-file module: Firebase init, utilities, and app logic.
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import {
  initializeFirestore,
  getFirestore,
  persistentLocalCache,
  persistentSingleTabManager,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  onSnapshot,
  collection,
  query,
  where,
  getDocs
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
/* ------------------------------------------------------------ */
/* Firebase init — SAME project as the Staff Portal.             */
/* ------------------------------------------------------------ */

const firebaseConfig = {
    apiKey: "AIzaSyDXSGE7SgPHGDlgxLAis2hFauILxhU9xSw",
    authDomain: "class-timetable-4fa15.firebaseapp.com",
    projectId: "class-timetable-4fa15",
    storageBucket: "class-timetable-4fa15.firebasestorage.app",
    messagingSenderId: "205483805792",
    appId: "1:205483805792:web:5a9ca2516e31baa2054705",
    measurementId: "G-8TV3JVCP97"
  };

const fbApp = initializeApp(firebaseConfig);

let db;
try {
  db = initializeFirestore(fbApp, {
    localCache: persistentLocalCache({ tabManager: persistentSingleTabManager({}) })
  });
} catch (e) {
  db = getFirestore(fbApp);
}

const auth = getAuth(fbApp);
setPersistence(auth, browserLocalPersistence).catch(() => {});

/* ------------------------------------------------------------ */
/* Firestore schema — confirmed against the Staff Portal's       */
/* actual data (Firebase console screenshots):                   */
/*                                                                */
/*   timetable/{DayN__HourM}                                     */
/*     dayOrder: "Day 1"   hour: "Hour 1"                        */
/*     staffName, staffPhotoURL, subjectId, subjectName          */
/*     (doc ID has NO spaces: dayOrder/hour field values stripped*/
/*      of spaces and joined with "__")                          */
/*                                                                */
/*   attendance/{YYYY-MM-DD__DayN__HourM}                        */
/*     date: "2026-07-18"  dayOrder: "Day 1"  hour: "Hour 1"     */
/*     records: { "<studentId>": "present" | "absent", ... }     */
/*     (lowercase status strings, one doc per hour per date —    */
/*      NOT nested under a single per-student/per-date doc)      */
/*                                                                */
/* There is no separate "dayOrders" collection — a date's Day    */
/* Order is only known once staff have created attendance docs   */
/* for that date (they carry dayOrder alongside date). Staff and */
/* subject names are embedded directly on the timetable doc, so  */
/* no separate staff/subjects lookups are needed.                */
/*                                                                */
/* ASSUMPTION TO DOUBLE-CHECK: the keys inside `records` are     */
/* assumed to be the exact same roll number string used as the   */
/* `students/{rollNumber}` document ID (and used to log in). If  */
/* staff instead key by some other internal student ID, swap the */
/* lookup in loadAttendanceForDate / loadAttendanceSummary below.*/
/* ------------------------------------------------------------ */
const COLLECTIONS = {
  students: "students",
  studentAccounts: "studentAccounts",
  timetable: "timetable",
  attendance: "attendance"
};

const AUTH_EMAIL_DOMAIN = "mvconnect.local";

/* ------------------------------------------------------------ */
/* Utilities (validation, toast, theme, dates, cropper, DOM)      */
/* ------------------------------------------------------------ */

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim());
}
function isValidMobile(mobile) {
  return /^[6-9]\d{9}$/.test(String(mobile).trim());
}
function isValidRollNumber(roll) {
  return /^[A-Za-z0-9\-\/]{3,20}$/.test(String(roll).trim());
}
function passwordStrengthOk(pw) {
  return typeof pw === "string" && pw.length >= 6;
}

let toastTimer = null;
function showToast(message, type = "info", duration = 2600) {
  const host = document.getElementById("toastHost");
  if (!host) return;
  host.textContent = "";
  const node = document.createElement("div");
  node.className = `toast toast--${type}`;
  node.textContent = message;
  host.appendChild(node);
  requestAnimationFrame(() => node.classList.add("toast--in"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.classList.remove("toast--in");
    setTimeout(() => node.remove(), 200);
  }, duration);
}

const THEME_KEY = "mvc_theme";
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(saved || (prefersDark ? "dark" : "light"), false);
}
function applyTheme(theme, persist = true) {
  document.documentElement.setAttribute("data-theme", theme);
  if (persist) localStorage.setItem(THEME_KEY, theme);
  document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
    btn.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
  });
}
function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "light";
  const next = current === "dark" ? "light" : "dark";
  applyTheme(next);
  return next;
}

function todayISO() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}
function formatDisplayDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
}

/* ---- Day Order / Hour label <-> doc ID helpers ---- */
function dayOrderLabel(n) {
  return `Day ${n}`;
}
function timetableDocId(dayOrderStr, hourStr) {
  return `${String(dayOrderStr).replace(/\s+/g, "")}__${String(hourStr).replace(/\s+/g, "")}`;
}
function parseHourNumber(hourStr) {
  const m = String(hourStr || "").match(/\d+/);
  return m ? parseInt(m[0], 10) : 0;
}
function normalizeStatus(raw) {
  const v = String(raw || "").toLowerCase();
  if (v === "present") return "PRESENT";
  if (v === "absent") return "ABSENT";
  return "NOT_MARKED";
}

function computeAttendanceSummary(records) {
  const byDate = {};
  let presentHours = 0;
  let absentHours = 0;

  records.forEach((r) => {
    if (r.status !== "PRESENT" && r.status !== "ABSENT") return;
    if (r.status === "PRESENT") presentHours++;
    if (r.status === "ABSENT") absentHours++;
    byDate[r.date] = byDate[r.date] || [];
    byDate[r.date].push(r.status);
  });

  let presentDays = 0;
  let absentDays = 0;
  Object.values(byDate).forEach((statuses) => {
    if (statuses.length === 0) return;
    if (statuses.includes("ABSENT")) absentDays++;
    else presentDays++;
  });

  const totalMarked = presentHours + absentHours;
  const percentage = totalMarked > 0 ? Math.round((presentHours / totalMarked) * 1000) / 10 : null;

  return { presentHours, absentHours, presentDays, absentDays, totalMarked, percentage };
}

/**
 * Crop tool used inside the "Adjust photo" modal: drag to pan (both
 * axes), plus an external zoom amount driven by the modal's
 * <input type="range"> slider. Panning is clamped so the circle is
 * always fully covered by the image.
 */
function createCropper(imageSrc, containerEl, size = 220) {
  const state = { scale: 1, minScale: 1, x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 };

  containerEl.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "cropper";
  wrap.style.width = size + "px";
  wrap.style.height = size + "px";

  const img = new Image();
  img.className = "cropper__img";
  img.src = imageSrc;
  wrap.appendChild(img);
  containerEl.appendChild(wrap);

  function clamp() {
    const w = img.naturalWidth * state.scale;
    const h = img.naturalHeight * state.scale;
    const maxX = Math.max(0, (w - size) / 2);
    const maxY = Math.max(0, (h - size) / 2);
    state.x = Math.min(maxX, Math.max(-maxX, state.x));
    state.y = Math.min(maxY, Math.max(-maxY, state.y));
  }

  function render() {
    clamp();
    const w = img.naturalWidth * state.scale;
    const h = img.naturalHeight * state.scale;
    img.style.width = w + "px";
    img.style.height = h + "px";
    img.style.left = size / 2 - w / 2 + state.x + "px";
    img.style.top = size / 2 - h / 2 + state.y + "px";
  }

  img.onload = () => {
    state.minScale = Math.max(size / img.naturalWidth, size / img.naturalHeight);
    state.scale = state.minScale;
    state.x = 0;
    state.y = 0;
    render();
  };

  function pointerDown(e) {
    state.dragging = true;
    const p = e.touches ? e.touches[0] : e;
    state.lastX = p.clientX;
    state.lastY = p.clientY;
  }
  function pointerMove(e) {
    if (!state.dragging) return;
    const p = e.touches ? e.touches[0] : e;
    state.x += p.clientX - state.lastX;
    state.y += p.clientY - state.lastY;
    state.lastX = p.clientX;
    state.lastY = p.clientY;
    render();
    e.preventDefault();
  }
  function pointerUp() {
    state.dragging = false;
  }

  wrap.addEventListener("mousedown", pointerDown);
  window.addEventListener("mousemove", pointerMove);
  window.addEventListener("mouseup", pointerUp);
  wrap.addEventListener("touchstart", pointerDown, { passive: true });
  wrap.addEventListener("touchmove", pointerMove, { passive: false });
  wrap.addEventListener("touchend", pointerUp);

  return {
    // t is 0..1, coming straight from the slider (value/100).
    setZoomAbsolute(t) {
      const clamped = Math.min(1, Math.max(0, t));
      state.scale = state.minScale + clamped * (state.minScale * 1.2);
      render();
    },
    destroy() {
      window.removeEventListener("mousemove", pointerMove);
      window.removeEventListener("mouseup", pointerUp);
    },
    // Returns a base64 JPEG data URL — this is what gets saved directly
    // as the `photoURL` string field on the Firestore student document
    // (no Storage bucket, no upload step, no download-URL round trip).
    getDataURL(outSize = 320) {
      const canvas = document.createElement("canvas");
      canvas.width = outSize; // kept modest so the base64 string stays
      canvas.height = outSize; // well under Firestore's 1MB doc limit
      const ctx = canvas.getContext("2d");
      const ratio = outSize / size;
      const drawW = img.naturalWidth * state.scale * ratio;
      const drawH = img.naturalHeight * state.scale * ratio;
      const cx = outSize / 2 + state.x * ratio;
      const cy = outSize / 2 + state.y * ratio;
      ctx.save();
      ctx.beginPath();
      ctx.arc(outSize / 2, outSize / 2, outSize / 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(img, cx - drawW / 2, cy - drawH / 2, drawW, drawH);
      ctx.restore();
      return canvas.toDataURL("image/jpeg", 0.8);
    }
  };
}

function qs(sel, root = document) {
  return root.querySelector(sel);
}
function qsa(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  });
  children.forEach((c) => node.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
  return node;
}

function placeholderAvatarDataURI() {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
    '<circle cx="50" cy="50" r="50" fill="#F7D6E4"/>' +
    '<circle cx="50" cy="38" r="18" fill="#E85D9B"/>' +
    '<ellipse cx="50" cy="86" rx="30" ry="22" fill="#E85D9B"/>' +
    "</svg>";
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

/* ------------------------------------------------------------ */
/* Global state                                                  */
/* ------------------------------------------------------------ */

const state = {
  user: null,
  profile: null,
  activeListeners: [],
  view: "dashboard-attendance",
  attDate: todayISO(),
  ttDayOrder: 1,
  timetableCache: new Map(), // key: "DayN__HourM" -> timetable doc data
  authFlowOwned: false
};

// Pending (not-yet-saved) photo data URLs captured from the "Adjust
// photo" modal for each flow. Kept outside `state` since they're
// transient UI values, not app/profile data.
let regPhotoDataURL = "";
let editPhotoDataURL = "";

// The single shared "Adjust photo" modal's current cropper + the
// callback to invoke with the final data URL when "Use photo" is pressed.
const photoModalState = { cropper: null, onConfirm: null };

function clearListeners() {
  state.activeListeners.forEach((unsub) => {
    try {
      unsub();
    } catch (e) {}
  });
  state.activeListeners = [];
}

/* ------------------------------------------------------------ */
/* Bootstrap                                                     */
/* ------------------------------------------------------------ */

document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  qs("#regPhotoThumb").src = placeholderAvatarDataURI();
  wireStaticEvents();
  onAuthStateChanged(auth, handleAuthChange);
});

function handleAuthChange(user) {
  if (state.authFlowOwned) return;

  if (user) {
    loadStudentProfile(user).then((ok) => {
      hideSplash();
      if (ok) {
        state.user = user;
        showApp();
      } else {
        signOut(auth);
      }
    });
  } else {
    clearListeners();
    state.user = null;
    state.profile = null;
    hideSplash();
    showAuthGate();
  }
}

function hideSplash() {
  const splash = qs("#splash");
  if (splash) splash.classList.add("is-hidden");
}

async function loadStudentProfile(user) {
  try {
    const acctSnap = await getDoc(doc(db, COLLECTIONS.studentAccounts, user.uid));
    if (!acctSnap.exists()) return false;
    const { rollNumber } = acctSnap.data();
    const studentSnap = await getDoc(doc(db, COLLECTIONS.students, rollNumber));
    if (!studentSnap.exists()) return false;
    state.profile = { rollNumber, ...studentSnap.data() };
    return true;
  } catch (e) {
    console.error("Profile load failed", e);
    return false;
  }
}

/* ------------------------------------------------------------ */
/* View switching (auth gate)                                    */
/* ------------------------------------------------------------ */

function showAuthGate() {
  qs("#appShell").classList.add("is-hidden");
  qs("#authGate").classList.remove("is-hidden");
  switchAuthView("welcome");
}

function switchAuthView(name) {
  qsa(".auth-view").forEach((v) => v.classList.toggle("is-active", v.dataset.authView === name));
}

function showApp() {
  qs("#authGate").classList.add("is-hidden");
  qs("#appShell").classList.remove("is-hidden");
  renderProfileChrome();
  navigateTo("dashboard-attendance");
}

/* ------------------------------------------------------------ */
/* Photo modal (shared by Register + Edit Profile)                */
/* ------------------------------------------------------------ */

function openPhotoModal(file, onConfirm) {
  const reader = new FileReader();
  reader.onload = () => {
    const host = qs("#modalCropperHost");
    photoModalState.cropper = createCropper(reader.result, host, 220);
    photoModalState.onConfirm = onConfirm;
    qs("#modalZoomRange").value = 0;
    qs("#photoModal").classList.remove("is-hidden");
  };
  reader.readAsDataURL(file);
}

function closePhotoModal() {
  qs("#photoModal").classList.add("is-hidden");
  if (photoModalState.cropper) photoModalState.cropper.destroy();
  qs("#modalCropperHost").innerHTML = "";
  photoModalState.cropper = null;
  photoModalState.onConfirm = null;
}

/* ------------------------------------------------------------ */
/* Static event wiring                                            */
/* ------------------------------------------------------------ */

function wireStaticEvents() {
  qs("#btnGoLogin").addEventListener("click", () => switchAuthView("login"));
  qs("#btnGoRegister").addEventListener("click", () => switchAuthView("register"));
  qsa("[data-back-welcome]").forEach((b) => b.addEventListener("click", () => switchAuthView("welcome")));
  qs("#btnGoRegisterFromLogin").addEventListener("click", () => switchAuthView("register"));

  qs("#loginForm").addEventListener("submit", onLoginSubmit);

  qs("#rollNumberInput").addEventListener("blur", onRollNumberLookup);
  qs("#registerForm").addEventListener("submit", onRegisterSubmit);

  qs("#regPhotoInput").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    openPhotoModal(file, (dataURL) => {
      regPhotoDataURL = dataURL;
      qs("#regPhotoThumb").src = dataURL;
    });
    e.target.value = ""; // allow re-selecting the same file later
  });

  qs("#editPhotoInput").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    openPhotoModal(file, (dataURL) => {
      editPhotoDataURL = dataURL;
      qs("#editPhotoThumb").src = dataURL;
    });
    e.target.value = "";
  });

  qs("#modalZoomRange").addEventListener("input", (e) => {
    if (photoModalState.cropper) {
      photoModalState.cropper.setZoomAbsolute(Number(e.target.value) / 100);
    }
  });
  qs("#modalCancelBtn").addEventListener("click", closePhotoModal);
  qs("#modalUseBtn").addEventListener("click", () => {
    if (photoModalState.cropper && photoModalState.onConfirm) {
      photoModalState.onConfirm(photoModalState.cropper.getDataURL());
    }
    closePhotoModal();
  });

  qsa("[data-nav]").forEach((btn) => btn.addEventListener("click", () => navigateTo(btn.dataset.nav)));

  qsa("[data-theme-toggle]").forEach((btn) => btn.addEventListener("click", () => toggleTheme()));

  qs("#btnLogout").addEventListener("click", doLogout);
  qs("#btnLogoutSidebar").addEventListener("click", doLogout);

  qs("#attendanceDate").addEventListener("change", (e) => {
    state.attDate = e.target.value;
    loadAttendanceForDate();
  });

  qsa("[data-dayorder]").forEach((chip) =>
    chip.addEventListener("click", () => {
      state.ttDayOrder = Number(chip.dataset.dayorder);
      qsa("[data-dayorder]").forEach((c) => c.classList.toggle("is-active", Number(c.dataset.dayorder) === state.ttDayOrder));
      loadTimetableForDayOrder();
    })
  );

  qs("#btnEditProfile").addEventListener("click", openProfileEdit);
  qs("#btnCancelEdit").addEventListener("click", closeProfileEdit);
  qs("#profileEditForm").addEventListener("submit", onProfileSave);

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    window.__deferredInstallPrompt = e;
    qs("#btnInstallApp").classList.remove("is-hidden");
  });
  qs("#btnInstallApp").addEventListener("click", async () => {
    const promptEvent = window.__deferredInstallPrompt;
    if (!promptEvent) return;
    promptEvent.prompt();
    await promptEvent.userChoice;
    window.__deferredInstallPrompt = null;
    qs("#btnInstallApp").classList.add("is-hidden");
  });
}

async function doLogout() {
  clearListeners();
  await signOut(auth);
  showToast("Signed out", "info");
}

function navigateTo(view) {
  state.view = view;
  qsa(".view").forEach((v) => v.classList.toggle("is-active", v.id === view));
  qsa("[data-nav]").forEach((btn) => btn.classList.toggle("is-active", btn.dataset.nav === view));
  clearListeners();

  if (view === "dashboard-attendance") {
    qs("#attendanceDate").value = state.attDate;
    loadAttendanceForDate();
  } else if (view === "dashboard-timetable") {
    loadTimetableForDayOrder();
  } else if (view === "dashboard-summary") {
    loadAttendanceSummary();
  } else if (view === "dashboard-profile") {
    renderProfileChrome();
  }
}

/* ------------------------------------------------------------ */
/* Login                                                          */
/* ------------------------------------------------------------ */

async function onLoginSubmit(e) {
  e.preventDefault();
  const roll = qs("#loginRoll").value.trim();
  const password = qs("#loginPassword").value;
  const btn = qs("#loginSubmitBtn");
  if (!roll || !password) return showToast("Enter roll number and password", "error");

  btn.disabled = true;
  btn.classList.add("is-loading");
  state.authFlowOwned = true;
  try {
    const email = `${roll.toLowerCase()}@${AUTH_EMAIL_DOMAIN}`;
    const cred = await signInWithEmailAndPassword(auth, email, password);
    const ok = await loadStudentProfile(cred.user);
    if (ok) {
      state.user = cred.user;
      showApp();
    } else {
      await signOut(auth);
      showToast("This account isn't linked to a student profile yet. Please register or contact your department office.", "error");
    }
  } catch (err) {
    showToast(mapAuthError(err), "error");
  } finally {
    btn.disabled = false;
    btn.classList.remove("is-loading");
    state.authFlowOwned = false;
  }
}

function mapAuthError(err) {
  const code = err && err.code;
  if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found") {
    return "Roll number or password is incorrect.";
  }
  if (code === "auth/too-many-requests") return "Too many attempts. Try again later.";
  return "Something went wrong. Please try again.";
}

/* ------------------------------------------------------------ */
/* Registration                                                    */
/* ------------------------------------------------------------ */

let lookedUpStudent = null;

async function onRollNumberLookup() {
  const roll = qs("#rollNumberInput").value.trim();
  const nameField = qs("#regNameInput");
  const helper = qs("#rollLookupHelper");
  lookedUpStudent = null;
  if (!roll) return;

  if (!isValidRollNumber(roll)) {
    helper.textContent = "Enter a valid roll number.";
    helper.className = "field-helper field-helper--error";
    return;
  }

  helper.textContent = "Checking roll number…";
  helper.className = "field-helper";

  try {
    const snap = await getDoc(doc(db, COLLECTIONS.students, roll));
    if (!snap.exists()) {
      helper.textContent = "Roll number not found. Contact your department office.";
      helper.className = "field-helper field-helper--error";
      nameField.value = "";
      nameField.disabled = true;
      return;
    }
    const data = snap.data();
    if (data.authUid) {
      helper.textContent = "An account already exists for this roll number.";
      helper.className = "field-helper field-helper--error";
      nameField.value = "";
      nameField.disabled = true;
      return;
    }
    lookedUpStudent = { rollNumber: roll, ...data };
    nameField.disabled = false;
    nameField.value = data.name || "";
    if (data.photoURL) {
      qs("#regPhotoThumb").src = data.photoURL;
    }
    helper.textContent = "Roll number verified.";
    helper.className = "field-helper field-helper--ok";
  } catch (e) {
    helper.textContent = "Could not verify roll number. Check your connection.";
    helper.className = "field-helper field-helper--error";
  }
}

async function onRegisterSubmit(e) {
  e.preventDefault();
  if (!lookedUpStudent) return showToast("Verify your roll number first", "error");

  const name = qs("#regNameInput").value.trim();
  const email = qs("#regEmailInput").value.trim();
  const mobile = qs("#regMobileInput").value.trim();
  const department = qs("#regDeptInput").value.trim();
  const klass = qs("#regClassInput").value.trim();
  const password = qs("#regPasswordInput").value;
  const confirm = qs("#regConfirmInput").value;

  if (!name) return showToast("Enter your name", "error");
  if (!isValidEmail(email)) return showToast("Enter a valid email address", "error");
  if (!isValidMobile(mobile)) return showToast("Enter a valid 10-digit mobile number", "error");
  if (!department || !klass) return showToast("Enter department and class", "error");
  if (!passwordStrengthOk(password)) return showToast("Password must be at least 6 characters", "error");
  if (password !== confirm) return showToast("Passwords do not match", "error");

  const btn = qs("#registerSubmitBtn");
  btn.disabled = true;
  btn.classList.add("is-loading");
  state.authFlowOwned = true;

  let cred = null;
  try {
    const roll = lookedUpStudent.rollNumber;
    const authEmail = `${roll.toLowerCase()}@${AUTH_EMAIL_DOMAIN}`;
    cred = await createUserWithEmailAndPassword(auth, authEmail, password);

    // Base64 JPEG data URL captured from the Adjust Photo modal, if the
    // student picked one; otherwise keep whatever photo already exists
    // on the record (set by staff), otherwise blank (placeholder shown).
    const photoURL = regPhotoDataURL || lookedUpStudent.photoURL || "";

    await setDoc(
      doc(db, COLLECTIONS.students, roll),
      {
        rollNumber: roll,
        name,
        email,
        mobile,
        department,
        class: klass,
        photoURL,
        authUid: cred.user.uid,
        updatedAt: Date.now()
      },
      { merge: true }
    );

    await setDoc(doc(db, COLLECTIONS.studentAccounts, cred.user.uid), {
      rollNumber: roll,
      createdAt: Date.now()
    });

    const ok = await loadStudentProfile(cred.user);
    if (ok) {
      state.user = cred.user;
      showToast("Account created! Welcome to ClassTrack.", "success");
      regPhotoDataURL = "";
      qs("#regPhotoThumb").src = placeholderAvatarDataURI();
      qs("#registerForm").reset();
      showApp();
    } else {
      throw new Error("profile-link-failed");
    }
  } catch (err) {
    console.error(err);
    if (cred && cred.user) {
      await cred.user.delete().catch(() => signOut(auth).catch(() => {}));
    }
    if (err.code === "auth/email-already-in-use") {
      showToast("An account already exists for this roll number.", "error");
    } else {
      showToast("Registration failed. Please try again.", "error");
    }
  } finally {
    btn.disabled = false;
    btn.classList.remove("is-loading");
    state.authFlowOwned = false;
  }
}

/* ------------------------------------------------------------ */
/* Timetable hour lookups (shared by Attendance + Timetable views) */
/* ------------------------------------------------------------ */

async function getTimetableHourCached(dayOrderStr, hourStr) {
  const key = timetableDocId(dayOrderStr, hourStr);
  if (state.timetableCache.has(key)) return state.timetableCache.get(key);
  const snap = await getDoc(doc(db, COLLECTIONS.timetable, key));
  const data = snap.exists() ? snap.data() : null;
  state.timetableCache.set(key, data);
  return data;
}

/* ------------------------------------------------------------ */
/* Attendance – daily view                                        */
/* ------------------------------------------------------------ */

async function loadAttendanceForDate() {
  const container = qs("#attendanceHours");
  const meta = qs("#attendanceMeta");
  container.innerHTML = renderSkeletonCards(5);
  clearListeners();

  try {
    const attQuery = query(collection(db, COLLECTIONS.attendance), where("date", "==", state.attDate));
    const unsub = onSnapshot(
      attQuery,
      async (snap) => {
        if (snap.empty) {
          meta.textContent = `${formatDisplayDate(state.attDate)} — No attendance marked yet`;
          container.innerHTML = renderEmptyState("No attendance has been marked for this date yet.");
          return;
        }

        const hourDocs = snap.docs.map((d) => d.data());
        hourDocs.sort((a, b) => parseHourNumber(a.hour) - parseHourNumber(b.hour));
        meta.textContent = `${formatDisplayDate(state.attDate)} — ${hourDocs[0].dayOrder}`;

        container.innerHTML = "";
        for (const hourDoc of hourDocs) {
          const tt = await getTimetableHourCached(hourDoc.dayOrder, hourDoc.hour);
          const status = normalizeStatus((hourDoc.records || {})[state.profile.rollNumber]);
          container.appendChild(buildHourCard(parseHourNumber(hourDoc.hour), tt, status));
        }
      },
      (err) => {
        console.error(err);
        container.innerHTML = renderEmptyState("Could not load attendance. Check your connection.");
      }
    );
    state.activeListeners.push(unsub);
  } catch (e) {
    console.error(e);
    container.innerHTML = renderEmptyState("Could not load attendance. Check your connection.");
  }
}

function buildHourCard(hourNumber, tt, status) {
  const statusClass = status === "PRESENT" ? "status--present" : status === "ABSENT" ? "status--absent" : "status--unmarked";
  const statusLabel = status === "PRESENT" ? "Present" : status === "ABSENT" ? "Absent" : "Not marked";

  return el("div", { class: "hour-card" }, [
    el("div", { class: "hour-card__badge" }, [`Hour ${hourNumber}`]),
    el("img", {
      class: "hour-card__avatar",
      src: (tt && tt.staffPhotoURL) || placeholderAvatarDataURI(),
      alt: ""
    }),
    el("div", { class: "hour-card__info" }, [
      el("div", { class: "hour-card__subject" }, [tt ? tt.subjectName : "Subject unavailable"]),
      el("div", { class: "hour-card__staff" }, [tt ? tt.staffName : "Staff unavailable"])
    ]),
    el("div", { class: `hour-card__status ${statusClass}` }, [statusLabel])
  ]);
}

/* ------------------------------------------------------------ */
/* Timetable page                                                  */
/* ------------------------------------------------------------ */

async function loadTimetableForDayOrder() {
  const container = qs("#timetableHours");
  container.innerHTML = renderSkeletonCards(5);
  clearListeners();

  const label = dayOrderLabel(state.ttDayOrder);
  const ttQuery = query(collection(db, COLLECTIONS.timetable), where("dayOrder", "==", label));
  const unsub = onSnapshot(
    ttQuery,
    (snap) => {
      if (snap.empty) {
        container.innerHTML = renderEmptyState("No timetable published for this Day Order yet.");
        return;
      }
      const hours = snap.docs.map((d) => d.data());
      hours.sort((a, b) => parseHourNumber(a.hour) - parseHourNumber(b.hour));

      container.innerHTML = "";
      hours.forEach((h) => {
        container.appendChild(
          el("div", { class: "hour-card hour-card--static" }, [
            el("div", { class: "hour-card__badge" }, [`Hour ${parseHourNumber(h.hour)}`]),
            el("img", { class: "hour-card__avatar", src: h.staffPhotoURL || placeholderAvatarDataURI(), alt: "" }),
            el("div", { class: "hour-card__info" }, [
              el("div", { class: "hour-card__subject" }, [h.subjectName || "Subject unavailable"]),
              el("div", { class: "hour-card__staff" }, [h.staffName || "Staff unavailable"])
            ])
          ])
        );
      });
    },
    (err) => {
      console.error(err);
      container.innerHTML = renderEmptyState("Could not load timetable. Check your connection.");
    }
  );
  state.activeListeners.push(unsub);
}

/* ------------------------------------------------------------ */
/* Attendance summary                                               */
/* ------------------------------------------------------------ */

async function loadAttendanceSummary() {
  const grid = qs("#summaryGrid");
  grid.innerHTML = renderSkeletonCards(4, "stat-card");
  try {
    // `attendance` docs don't carry a rollNumber field to filter by server
    // side — each doc's `records` map covers every student for that hour.
    // We pull the whole collection and pick out this student's own status.
    const snap = await getDocs(collection(db, COLLECTIONS.attendance));
    const records = [];
    snap.forEach((docSnap) => {
      const data = docSnap.data();
      const raw = (data.records || {})[state.profile.rollNumber];
      if (raw === undefined) return;
      records.push({ status: normalizeStatus(raw), date: data.date });
    });

    const s = computeAttendanceSummary(records);
    grid.innerHTML = "";
    grid.appendChild(buildStatCard("Present Hours", s.presentHours, "present"));
    grid.appendChild(buildStatCard("Absent Hours", s.absentHours, "absent"));
    grid.appendChild(buildStatCard("Present Days", s.presentDays, "present"));
    grid.appendChild(buildStatCard("Absent Days", s.absentDays, "absent"));

    qs("#summaryExtra").innerHTML = "";
    qs("#summaryExtra").appendChild(
      el("div", { class: "summary-extra" }, [
        el("span", {}, [`Total Marked Hours: ${s.totalMarked}`]),
        el("span", {}, [s.percentage === null ? "Attendance %: —" : `Attendance %: ${s.percentage}%`])
      ])
    );
  } catch (e) {
    console.error(e);
    grid.innerHTML = renderEmptyState("Could not load attendance summary.");
  }
}

function buildStatCard(label, value, tone) {
  return el("div", { class: `stat-card stat-card--${tone}` }, [
    el("div", { class: "stat-card__value" }, [String(value)]),
    el("div", { class: "stat-card__label" }, [label])
  ]);
}

/* ------------------------------------------------------------ */
/* Profile                                                          */
/* ------------------------------------------------------------ */

function renderProfileChrome() {
  if (!state.profile) return;
  const p = state.profile;
  qsa("[data-profile-name]").forEach((n) => (n.textContent = p.name || "Student"));
  qsa("[data-profile-roll]").forEach((n) => (n.textContent = p.rollNumber || ""));
  qsa("[data-profile-photo]").forEach((img) => (img.src = p.photoURL || placeholderAvatarDataURI()));
  qs("#profileEmail") && (qs("#profileEmail").textContent = p.email || "—");
  qs("#profileMobile") && (qs("#profileMobile").textContent = p.mobile || "—");
  qs("#profileDept") && (qs("#profileDept").textContent = p.department || "—");
  qs("#profileClass") && (qs("#profileClass").textContent = p.class || "—");
}

function openProfileEdit() {
  const p = state.profile;
  qs("#editNameInput").value = p.name || "";
  qs("#editEmailInput").value = p.email || "";
  qs("#editMobileInput").value = p.mobile || "";
  qs("#editDeptInput").value = p.department || "";
  qs("#editClassInput").value = p.class || "";
  editPhotoDataURL = "";
  qs("#editPhotoThumb").src = p.photoURL || placeholderAvatarDataURI();
  qs("#profileView").classList.add("is-hidden");
  qs("#profileEditView").classList.remove("is-hidden");
}

function closeProfileEdit() {
  qs("#profileEditView").classList.add("is-hidden");
  qs("#profileView").classList.remove("is-hidden");
  editPhotoDataURL = "";
}

async function onProfileSave(e) {
  e.preventDefault();
  const name = qs("#editNameInput").value.trim();
  const email = qs("#editEmailInput").value.trim();
  const mobile = qs("#editMobileInput").value.trim();
  const department = qs("#editDeptInput").value.trim();
  const klass = qs("#editClassInput").value.trim();

  if (!name) return showToast("Name cannot be empty", "error");
  if (!isValidEmail(email)) return showToast("Enter a valid email address", "error");
  if (!isValidMobile(mobile)) return showToast("Enter a valid 10-digit mobile number", "error");

  const btn = qs("#profileSaveBtn");
  btn.disabled = true;
  btn.classList.add("is-loading");

  try {
    const updates = { name, email, mobile, department, class: klass, updatedAt: Date.now() };
    if (editPhotoDataURL) {
      updates.photoURL = editPhotoDataURL;
    }
    await updateDoc(doc(db, COLLECTIONS.students, state.profile.rollNumber), updates);
    state.profile = { ...state.profile, ...updates };
    renderProfileChrome();
    closeProfileEdit();
    showToast("Profile updated", "success");
  } catch (err) {
    console.error(err);
    showToast("Could not save changes. Try again.", "error");
  } finally {
    btn.disabled = false;
    btn.classList.remove("is-loading");
  }
}

/* ------------------------------------------------------------ */
/* Render helpers                                                   */
/* ------------------------------------------------------------ */

function renderSkeletonCards(count, extraClass = "hour-card") {
  return Array.from({ length: count })
    .map(() => `<div class="${extraClass} skeleton"></div>`)
    .join("");
}

function renderEmptyState(message) {
  return `<div class="empty-state">${message}</div>`;
}

/* ------------------------------------------------------------ */
/* Service worker registration                                       */
/* ------------------------------------------------------------ */

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch((e) => console.warn("SW registration failed", e));
  });
}