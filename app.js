/* ============================================================
   Peak — lógica
   Datos en localStorage + sync con Appwrite
   ============================================================ */

const STORAGE_KEY = 'notas-faltas-v2';
const LEGACY_KEY = 'gradeManagerData';
const THEME_KEY = 'notas-faltas-theme';

// Appwrite config
const APPWRITE_ENDPOINT = 'https://fra.cloud.appwrite.io/v1';
const APPWRITE_PROJECT_ID = '6ae100ae003dc1ddccdb';
const MODIFIED_KEY = 'peak-modified-at';

// Appwrite instances
let appwriteClient = null;
let appwriteAccount = null;
let appwriteCurrentUser = null;
let appwriteSyncEnabled = false;
let syncTimer = null;
let syncInFlight = false;

function initAppwrite() {
  try {
    if (typeof Appwrite === 'undefined') {
      console.warn('SDK de Appwrite no disponible');
      return false;
    }
    appwriteClient = new Appwrite.Client()
      .setEndpoint(APPWRITE_ENDPOINT)
      .setProject(APPWRITE_PROJECT_ID);
    appwriteAccount = new Appwrite.Account(appwriteClient);
    return true;
  } catch (e) {
    console.warn('Appwrite init failed', e);
    return false;
  }
}

async function getAppwriteUser() {
  if (!appwriteAccount) return null;
  try {
    appwriteCurrentUser = await appwriteAccount.get();
    return appwriteCurrentUser;
  } catch (e) {
    appwriteCurrentUser = null;
    return null;
  }
}

const TYPES = {
  examenes: { label: 'Exámenes', short: 'Solo exámenes', icon: 'ico-exam' },
  trabajos: { label: 'Trabajos', short: 'Solo trabajos', icon: 'ico-work' },
  mixto: { label: 'Exámenes + trabajos', short: 'Exámenes y trabajos', icon: 'ico-mix' }
};

const DEFAULTS = () => ({
  weights: { examenes: 60, trabajos: 40 },
  attendance: { totalClasses: 30, justifiedPct: 15, unjustifiedPct: 10 },
  exams: [],
  works: [],
  absences: []
});

/* ---------- Utilidades ---------- */
const uid = () => (window.crypto && crypto.randomUUID)
  ? crypto.randomUUID()
  : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);

const num = (value, fallback = 0) => {
  const n = parseFloat(String(value ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
};

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

const parseGrade = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = num(value, NaN);
  return Number.isFinite(n) ? clamp(n, 0, 10) : null;
};

const parseWeight = (value) => {
  if (value === null || value === undefined || value === '') return 0;
  const n = num(value, NaN);
  return Number.isFinite(n) ? clamp(n, 0, 100) : 0;
};

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const formatDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
};

const formatLongDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' });
};

const todayISO = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

const normalizeType = (type) => {
  if (type === 'examenes' || type === 'trabajos' || type === 'mixto') return type;
  if (type === 'solo_trabajos') return 'trabajos';
  if (type === 'solo_examenes') return 'examenes';
  return 'mixto';
};

/* ---------- Cálculos ---------- */
const hasGrade = (item) => Boolean(item)
  && item.grade !== null
  && item.grade !== undefined
  && item.grade !== ''
  && Number.isFinite(num(item.grade, NaN));

const isPending = (item) => Boolean(item) && item.done === false;

const countsForGrade = (item) => !isPending(item) && hasGrade(item);

/**
 * Pesos efectivos de una lista de evaluaciones.
 * Las evaluaciones sin peso se reparten a partes iguales lo que falta hasta el 100%.
 * Si ninguna tiene peso, todas valen lo mismo.
 */
const effectiveWeights = (items) => {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];

  const weights = list.map((item) => Math.max(0, num(item.weight, 0)));
  const missing = weights.map((w, i) => (w > 0 ? -1 : i)).filter((i) => i >= 0);
  if (!missing.length) return weights;

  const assigned = weights.reduce((acc, w) => acc + w, 0);
  if (assigned <= 0) return weights.map(() => 100 / list.length);

  const share = Math.max(0, 100 - assigned) / missing.length;
  return weights.map((w) => (w > 0 ? w : share));
};

const weightedAverage = (items) => {
  // Solo cuentan las evaluaciones entregadas y con nota. Así una evaluación
  // futura no cambia la media de lo que ya tienes.
  const list = (Array.isArray(items) ? items : []).filter(countsForGrade);
  if (!list.length) return null;

  const weights = effectiveWeights(list);
  let sum = 0;
  let total = 0;
  list.forEach((item, index) => {
    sum += num(item.grade) * weights[index];
    total += weights[index];
  });
  return total > 0 ? sum / total : null;
};

const finalGrade = (subject) => {
  const examAvg = weightedAverage(subject.exams);
  const workAvg = weightedAverage(subject.works);
  const type = normalizeType(subject.type);

  if (type === 'examenes') return examAvg !== null ? examAvg : workAvg;
  if (type === 'trabajos') return workAvg !== null ? workAvg : examAvg;

  // materia mixta: solo tiene nota si ambas partes (exámenes y trabajos) tienen algo entregado
  if (type === 'mixto') {
    if (examAvg === null || workAvg === null) return null;
    const wE = num(subject.weights.examenes);
    const wT = num(subject.weights.trabajos);
    const total = wE + wT;
    if (total <= 0) return weightedAverage([...subject.exams, ...subject.works]);
    return (examAvg * wE + workAvg * wT) / total;
  }

  if (examAvg === null && workAvg === null) return null;
  if (examAvg === null) return workAvg;
  if (workAvg === null) return examAvg;

  const wE = num(subject.weights.examenes);
  const wT = num(subject.weights.trabajos);
  const total = wE + wT;
  if (total <= 0) return weightedAverage([...subject.exams, ...subject.works]);
  return (examAvg * wE + workAvg * wT) / total;
};

const absenceStats = (subject) => {
  const justified = subject.absences.filter((a) => a.type === 'justificada').length;
  const unjustified = subject.absences.filter((a) => a.type === 'injustificada').length;
  const total = subject.absences.length;
  const classes = Math.max(num(subject.attendance.totalClasses, 1), total);
  const maxJ = (classes * num(subject.attendance.justifiedPct)) / 100;
  const maxU = (classes * num(subject.attendance.unjustifiedPct)) / 100;
  const attendance = classes > 0 ? ((classes - total) / classes) * 100 : 100;

  return {
    justified, unjustified, total, classes, maxJ, maxU,
    attendance: clamp(attendance, 0, 100),
    jOver: justified > maxJ + 1e-9,
    uOver: unjustified > maxU + 1e-9
  };
};

const gradeTone = (grade) => {
  if (grade === null) return 'neutral';
  if (grade < 5) return 'bad';
  if (grade < 7) return 'warn';
  return 'ok';
};

const round1 = (n) => Math.round(n * 10) / 10;
const prettyNumber = (n) => (Number.isInteger(round1(n)) ? String(round1(n)) : round1(n).toFixed(1));

/* ---------- Almacenamiento ---------- */
class Store {
  constructor() {
    this.subjects = this.load();
    this.currentId = null;
  }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return this.sanitize(JSON.parse(raw));
    } catch (err) {
      console.warn('No se pudo leer el almacenamiento', err);
    }
    return this.migrateLegacy();
  }

  migrateLegacy() {
    try {
      const raw = localStorage.getItem(LEGACY_KEY);
      if (!raw) return [];
      const legacy = JSON.parse(raw);
      if (!Array.isArray(legacy)) return [];
      const migrated = legacy.map((s) => ({
        id: s.id || uid(),
        name: s.name || 'Materia',
        color: s.color || '#6366f1',
        type: 'trabajos',
        ...DEFAULTS(),
        weights: { examenes: 0, trabajos: 100 },
        works: (s.notes || []).map((n) => ({
          id: n.id || uid(),
          name: n.description || 'Trabajo',
          grade: num(n.grade),
          weight: num(n.weight, 100),
          date: String(n.date || '').slice(0, 10)
        })),
        absences: (s.absences || []).map((a) => ({
          id: a.id || uid(),
          date: a.date || '',
          reason: a.reason || '',
          type: a.justified ? 'justificada' : 'injustificada'
        }))
      }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
      return this.sanitize(migrated);
    } catch (err) {
      console.warn('Migración fallida', err);
      return [];
    }
  }

  sanitize(list) {
    if (!Array.isArray(list)) return [];
    return list.map((s) => {
      const d = DEFAULTS();
      return {
        id: s.id || uid(),
        name: String(s.name || 'Materia').slice(0, 60),
        color: /^#[0-9a-f]{6}$/i.test(s.color || '') ? s.color : '#6366f1',
        type: normalizeType(s.type),
        weights: {
          examenes: clamp(num(s.weights?.examenes, d.weights.examenes), 0, 100),
          trabajos: clamp(num(s.weights?.trabajos, d.weights.trabajos), 0, 100)
        },
        attendance: {
          totalClasses: clamp(num(s.attendance?.totalClasses, d.attendance.totalClasses), 1, 400),
          hoursPerWeek: s.attendance?.hoursPerWeek ? num(s.attendance.hoursPerWeek) : undefined,
          weeks: s.attendance?.weeks ? num(s.attendance.weeks) : undefined,
          justifiedPct: clamp(num(s.attendance?.justifiedPct, d.attendance.justifiedPct), 0, 100),
          unjustifiedPct: clamp(num(s.attendance?.unjustifiedPct, d.attendance.unjustifiedPct), 0, 100)
        },
        exams: (Array.isArray(s.exams) ? s.exams : []).map((e) => ({
          id: e.id || uid(),
          name: String(e.name || 'Examen').slice(0, 80),
          grade: parseGrade(e.grade),
          weight: parseWeight(e.weight),
          date: typeof e.date === 'string' ? e.date : '',
          done: e.done === undefined ? true : Boolean(e.done)
        })),
        works: (Array.isArray(s.works) ? s.works : []).map((w) => ({
          id: w.id || uid(),
          name: String(w.name || 'Trabajo').slice(0, 80),
          grade: parseGrade(w.grade),
          weight: parseWeight(w.weight),
          date: typeof w.date === 'string' ? w.date : '',
          done: w.done === undefined ? true : Boolean(w.done)
        })),
        absences: (Array.isArray(s.absences) ? s.absences : []).map((a) => ({
          id: a.id || uid(),
          date: typeof a.date === 'string' ? a.date : '',
          reason: String(a.reason || ''),
          type: a.type === 'injustificada' ? 'injustificada' : 'justificada'
        }))
      };
    });
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.subjects));
      localStorage.setItem(MODIFIED_KEY, String(Date.now()));
    } catch (err) {
      toast('No se pudieron guardar los datos', true);
      console.error(err);
    }
    // Avisa a la app para sincronizar en segundo plano
    if (window.app && typeof window.app.schedulePush === 'function') {
      window.app.schedulePush();
    }
  }

  all() { return this.subjects; }
  get(id) { return this.subjects.find((s) => s.id === id) || null; }

  add(subject) {
    this.subjects.push(subject);
    this.save();
    return subject;
  }

  remove(id) {
    this.subjects = this.subjects.filter((s) => s.id !== id);
    this.save();
  }
}

/* ---------- Toast ---------- */
let toastTimer = null;
function toast(message, isBad = false, action = null) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = message;
  el.appendChild(span);
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = 'Deshacer';
    btn.addEventListener('click', () => {
      action();
      el.classList.remove('is-visible');
    });
    el.appendChild(btn);
  }
  el.classList.toggle('is-bad', Boolean(isBad));
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), action ? 6000 : 2400);
}

/* ---------- App ---------- */
class App {
  constructor() {
    this.store = new Store();
    this.subjectFilter = 'all';
    this.itemFilter = 'all';
    this.itemKind = 'exam';
    this.currentView = 'inicio';
    this.calYear = new Date().getFullYear();
    this.calMonth = new Date().getMonth();
    this.init();
  }

  init() {
    this.applyTheme(this.loadTheme());
    this.bindTheme();
    this.bindGlobal();
    this.bindSubjectModal();
    this.bindDetail();
    this.bindItemModal();
    this.bindAbsenceModal();
    this.bindSync();
    this.setEyebrow();
    this.render();
    this.checkSyncOnLoad();
  }

  /* ----- Tema ----- */
  loadTheme() {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === 'light' || saved === 'dark') return saved;
    } catch (err) { /* ignora */ }
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch (err) { /* ignora */ }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? '#f3f4fa' : '#0a0b12');
  }

  bindTheme() {
    document.getElementById('themeBtn').addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      this.applyTheme(next);
    });
  }

  setEyebrow() {
    const now = new Date();
    const label = now.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
    document.getElementById('eyebrow').textContent = label.charAt(0).toUpperCase() + label.slice(1);
  }

  /* ----- Modales ----- */
  openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.add('is-open');
    document.body.style.overflow = 'hidden';
    const target = modal.querySelector('input:not([type=hidden]):not([type=radio]), select');
    if (target) setTimeout(() => target.focus({ preventScroll: true }), 70);
  }

  closeModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.remove('is-open');
    if (!document.querySelector('.modal.is-open')) document.body.style.overflow = '';
  }

  closeAllModals() {
    document.querySelectorAll('.modal.is-open').forEach((m) => m.classList.remove('is-open'));
    document.body.style.overflow = '';
  }

  /* ----- Global ----- */
  bindGlobal() {
    const addSubjectBtn = document.getElementById('addSubjectBtn');
    if (addSubjectBtn) addSubjectBtn.addEventListener('click', () => this.openSubjectModal());
    const emptyAddBtn = document.getElementById('emptyAddBtn');
    if (emptyAddBtn) emptyAddBtn.addEventListener('click', () => this.openSubjectModal());

    const exportBtn = document.getElementById('exportBtn');
    if (exportBtn) exportBtn.addEventListener('click', () => this.exportData());
    const footExport = document.getElementById('footExport');
    if (footExport) footExport.addEventListener('click', () => this.exportData());

    const importBtn = document.getElementById('importBtn');
    if (importBtn) importBtn.addEventListener('click', () => document.getElementById('importInput').click());
    const importInput = document.getElementById('importInput');
    if (importInput) importInput.addEventListener('change', (e) => this.importData(e));

    const syncBtn = document.getElementById('syncBtn');
    if (syncBtn) syncBtn.addEventListener('click', () => this.openSyncModal());

    document.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => this.closeModal(btn.dataset.close));
    });

    document.querySelectorAll('.modal').forEach((modal) => {
      modal.addEventListener('mousedown', (e) => {
        if (e.target === modal) this.closeModal(modal.id);
      });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const dm = document.getElementById('desktopMenu');
        if (dm && !dm.hidden) { dm.hidden = true; return; }
        const open = document.querySelectorAll('.modal.is-open');
        if (open.length) this.closeModal(open[open.length - 1].id);
      }
    });

    const subjectFilters = document.getElementById('subjectFilters');
    if (subjectFilters) subjectFilters.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-filter]');
      if (!btn) return;
      this.subjectFilter = btn.dataset.filter;
      document.querySelectorAll('#subjectFilters .filter').forEach((b) => {
        const active = b === btn;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', String(active));
      });
      this.renderSubjects();
    });

    // Menu desplegable de escritorio (tres rallitas)
    const desktopMenuBtn = document.getElementById('desktopMenuBtn');
    const desktopMenu = document.getElementById('desktopMenu');
    if (desktopMenuBtn && desktopMenu) {
      desktopMenuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        desktopMenu.hidden = !desktopMenu.hidden;
      });
      document.addEventListener('click', (e) => {
        if (!desktopMenu.hidden && !desktopMenu.contains(e.target) && !desktopMenuBtn.contains(e.target)) {
          desktopMenu.hidden = true;
        }
      });
      const closeDesktopMenu = () => { desktopMenu.hidden = true; };
      const ds = document.getElementById('desktopSyncBtn');
      if (ds) ds.addEventListener('click', () => { closeDesktopMenu(); this.openSyncModal(); });
      const de = document.getElementById('desktopExportBtn');
      if (de) de.addEventListener('click', () => { closeDesktopMenu(); this.exportData(); });
      const di = document.getElementById('desktopImportBtn');
      if (di) di.addEventListener('click', () => { closeDesktopMenu(); document.getElementById('importInput').click(); });
    }

    // Isla flotante movil: boton Anadir
    const islandAdd = document.getElementById('islandAddBtn');
    if (islandAdd) islandAdd.addEventListener('click', () => this.openSubjectModal());

    const calPrev = document.getElementById('calPrev');
    if (calPrev) calPrev.addEventListener('click', () => { this.calMonth--; if (this.calMonth < 0) { this.calMonth = 11; this.calYear--; } this.renderCalendar(); });
    const calNext = document.getElementById('calNext');
    if (calNext) calNext.addEventListener('click', () => { this.calMonth++; if (this.calMonth > 11) { this.calMonth = 0; this.calYear++; } this.renderCalendar(); });

    document.querySelectorAll('.view-tab').forEach((t) => {
      t.addEventListener('click', () => this.switchView(t.dataset.view));
    });

    this.bindMobileNav();
  }


  bindMobileNav() {
    // La isla flotante se ha retirado; mantenemos accesible el menú "Más" en el topbar.
    const moreBtn = document.getElementById('mobileMoreBtn');
    const sheet = document.getElementById('mobileMoreSheet');
    if (moreBtn && sheet) {
      moreBtn.addEventListener('click', () => sheet.classList.add('is-open'));
      sheet.querySelectorAll('[data-close-mobile-sheet]').forEach((btn) => {
        btn.addEventListener('click', () => sheet.classList.remove('is-open'));
      });
      sheet.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('mobile-sheet-backdrop')) sheet.classList.remove('is-open');
      });
    }

    const mobileExport = document.getElementById('mobileExportBtn');
    if (mobileExport) mobileExport.addEventListener('click', () => { document.getElementById('mobileMoreSheet').classList.remove('is-open'); this.exportData(); });

    const mobileImport = document.getElementById('mobileImportBtn');
    if (mobileImport) mobileImport.addEventListener('click', () => { document.getElementById('mobileMoreSheet').classList.remove('is-open'); document.getElementById('importInput').click(); });

    const mobileTheme = document.getElementById('mobileThemeBtn');
    if (mobileTheme) mobileTheme.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      this.applyTheme(next);
      document.getElementById('mobileMoreSheet').classList.remove('is-open');
    });

    const mobileSync = document.getElementById('mobileSyncBtn');
    if (mobileSync) mobileSync.addEventListener('click', () => {
      document.getElementById('mobileMoreSheet').classList.remove('is-open');
      this.openSyncModal();
    });
  }


  /* ----- Materia: alta y edición ----- */
  bindSubjectModal() {
    document.getElementById('subjectForm').addEventListener('submit', (e) => {
      e.preventDefault();
      this.saveSubject();
    });

    document.getElementById('subjectSwatches').addEventListener('click', (e) => {
      const swatch = e.target.closest('[data-color]');
      if (!swatch) return;
      document.getElementById('subjectColor').value = swatch.dataset.color;
      this.markSwatch(swatch.dataset.color);
    });

    document.getElementById('subjectColor').addEventListener('input', (e) => this.markSwatch(e.target.value));
  }

  markSwatch(color) {
    document.querySelectorAll('#subjectSwatches [data-color]').forEach((el) => {
      el.classList.toggle('is-active', el.dataset.color.toLowerCase() === String(color).toLowerCase());
    });
  }

  selectedType(name) {
    const checked = document.querySelector(`input[name="${name}"]:checked`);
    return normalizeType(checked ? checked.value : 'mixto');
  }

  openSubjectModal(id = null) {
    const subject = id ? this.store.get(id) : null;
    document.getElementById('subjectModalTitle').textContent = subject ? 'Editar materia' : 'Nueva materia';
    document.getElementById('subjectId').value = subject ? subject.id : '';
    document.getElementById('subjectName').value = subject ? subject.name : '';
    const type = subject ? normalizeType(subject.type) : 'examenes';
    document.querySelectorAll('input[name="subjectType"]').forEach((r) => { r.checked = r.value === type; });
    const color = subject ? subject.color : '#6366f1';
    document.getElementById('subjectColor').value = color;
    this.markSwatch(color);
    this.openModal('subjectModal');
  }

  saveSubject() {
    const id = document.getElementById('subjectId').value;
    const name = document.getElementById('subjectName').value.trim();
    const type = this.selectedType('subjectType');
    const color = document.getElementById('subjectColor').value || '#6366f1';

    if (!name) {
      toast('Ponle un nombre a la materia', true);
      document.getElementById('subjectName').focus();
      return;
    }

    if (id) {
      const subject = this.store.get(id);
      if (!subject) return;
      subject.name = name;
      subject.color = color;
      subject.type = type;
      if (type === 'examenes') subject.weights = { examenes: 100, trabajos: 0 };
      if (type === 'trabajos') subject.weights = { examenes: 0, trabajos: 100 };
      if (type === 'mixto' && subject.weights.examenes + subject.weights.trabajos !== 100) {
        subject.weights = { examenes: 60, trabajos: 40 };
      }
      this.store.save();
      toast('Materia actualizada');
      if (this.store.currentId === id) this.fillDetail();
    } else {
      const subject = {
        id: uid(),
        name,
        color,
        type,
        ...DEFAULTS(),
        weights: type === 'examenes'
          ? { examenes: 100, trabajos: 0 }
          : type === 'trabajos'
            ? { examenes: 0, trabajos: 100 }
            : { examenes: 60, trabajos: 40 }
      };
      this.store.add(subject);
      toast('Materia creada');
    }

    this.closeModal('subjectModal');
    this.render();
  }

  deleteSubject(id) {
    const subject = this.store.get(id);
    if (!subject) return;
    if (!window.confirm(`¿Eliminar "${subject.name}"? Se borrarán sus evaluaciones y faltas.`)) return;
    this.store.remove(id);
    if (this.store.currentId === id) {
      this.store.currentId = null;
      this.closeModal('detailModal');
    }
    this.render();
    toast('Materia eliminada');
  }

  /* ----- Panel ----- */
  render() {
    const subjects = this.store.all();
    const grades = subjects.map((s) => finalGrade(s)).filter((g) => g !== null);
    const average = grades.length ? grades.reduce((a, b) => a + b, 0) / grades.length : null;
    const absences = subjects.reduce((acc, s) => acc + s.absences.length, 0);
    const atRisk = subjects.filter((s) => {
      const st = absenceStats(s);
      return st.jOver || st.uOver;
    }).length;
    const pending = this.pendingItems();

    document.getElementById('statSubjects').textContent = String(subjects.length);
    document.getElementById('statAbsences').textContent = String(absences);
    document.getElementById('statRisk').textContent = String(atRisk);
    const pendingEl = document.getElementById('statPending');
    if (pendingEl) pendingEl.textContent = String(pending.length);

    const avgEl = document.getElementById('statAverage');
    avgEl.textContent = average === null ? '—' : average.toFixed(2);

    const ring = document.getElementById('ringAverage');
    const pct = average === null ? 0 : clamp(average / 10, 0, 1);
    ring.style.strokeDashoffset = String(326.73 * (1 - pct));
    ring.style.stroke = average === null
      ? 'var(--txt-3)'
      : average < 5 ? 'var(--bad)' : average < 7 ? 'var(--warn)' : 'var(--ok)';

    const sub = document.getElementById('heroSub');
    if (!subjects.length) {
      sub.textContent = 'Añade tu primera materia para empezar.';
    } else if (average === null) {
      sub.textContent = `${subjects.length} materia${subjects.length === 1 ? '' : 's'} sin evaluaciones todavía.`;
    } else {
      sub.textContent = `${subjects.length} materia${subjects.length === 1 ? '' : 's'} · ${absences} falta${absences === 1 ? '' : 's'} · media ${average.toFixed(2)}/10`;
    }

    document.getElementById('sectionSub').textContent = subjects.length
      ? `${subjects.length} materia${subjects.length === 1 ? '' : 's'} en este curso`
      : 'Sin materias todavía';

    const pendingSub = document.getElementById('pendingSub');
    if (pendingSub) {
      pendingSub.textContent = pending.length === 1
        ? '1 evaluación por entregar · la más próxima primero'
        : `${pending.length} evaluaciones por entregar · la más próxima primero`;
    }

    this.renderSubjects();
    this.renderPending();
    this.renderCalendar();
    this.switchView(this.currentView);
  }

  renderSubjects() {
    const grid = document.getElementById('subjectsGrid');
    const all = this.store.all();
    const list = this.subjectFilter === 'all'
      ? all
      : all.filter((s) => normalizeType(s.type) === this.subjectFilter);

    grid.innerHTML = '';

    const isEmpty = all.length === 0;
    document.getElementById('emptyState').classList.toggle('is-visible', isEmpty);
    grid.style.display = isEmpty ? 'none' : '';
    if (isEmpty) return;

    list.forEach((subject) => grid.appendChild(this.buildCard(subject)));

    if (!list.length) {
      const note = document.createElement('p');
      note.className = 'hint';
      note.style.padding = '1.5rem 0.25rem';
      note.textContent = 'No hay materias con este tipo de evaluación.';
      grid.appendChild(note);
    }
  }

  buildCard(subject) {
    const grade = finalGrade(subject);
    const examAvg = weightedAverage(subject.exams);
    const workAvg = weightedAverage(subject.works);
    const stats = absenceStats(subject);
    const type = TYPES[normalizeType(subject.type)];

    const card = document.createElement('article');
    card.className = 'subject-card';
    card.style.setProperty('--accent', subject.color);
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Abrir ${subject.name}`);

    const fal = stats.total === 0
      ? '<span class="mini-tag"><i class="dot dot-ok"></i> Sin faltas</span>'
      : `<span class="mini-tag ${stats.uOver ? 'is-bad' : stats.jOver ? 'is-warn' : ''}">
           <i class="dot ${stats.uOver ? 'dot-bad' : stats.jOver ? 'dot-warn' : 'dot-ok'}"></i>
           ${stats.justified}J · ${stats.unjustified}I
         </span>`;

    card.innerHTML = `
      <div class="card-top">
        <div class="card-titles">
          <span class="card-name">${escapeHtml(subject.name)}</span>
          <span class="badge"><span class="${type.icon}"></span>${type.short}</span>
        </div>
        <div class="card-grade">
          <strong>${grade === null ? '—' : grade.toFixed(2)}</strong>
          <span>nota final</span>
        </div>
      </div>

      <div class="card-bars">
        <div class="card-bar-row">
          <span>Exámenes</span>
          <div class="bar"><i class="bar-fill fill-exams" style="width:${examAvg === null ? 0 : clamp((examAvg / 10) * 100, 0, 100)}%"></i></div>
          <b>${examAvg === null ? '—' : examAvg.toFixed(2)}</b>
        </div>
        <div class="card-bar-row">
          <span>Trabajos</span>
          <div class="bar"><i class="bar-fill fill-works" style="width:${workAvg === null ? 0 : clamp((workAvg / 10) * 100, 0, 100)}%"></i></div>
          <b>${workAvg === null ? '—' : workAvg.toFixed(2)}</b>
        </div>
      </div>

      <div class="card-foot">
        <div class="card-foot-info">
          ${fal}
          <span class="mini-tag">Asist. ${stats.attendance.toFixed(0)}%</span>
        </div>
        <div class="mini-actions">
          <button class="icon-btn" type="button" data-edit aria-label="Editar ${escapeHtml(subject.name)}"><span class="ico-pen"></span></button>
          <button class="icon-btn" type="button" data-delete aria-label="Eliminar ${escapeHtml(subject.name)}"><span class="ico-trash"></span></button>
        </div>
      </div>
    `;

    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-edit]') || e.target.closest('[data-delete]')) return;
      this.openDetail(subject.id);
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.openDetail(subject.id);
      }
    });
    card.querySelector('[data-edit]').addEventListener('click', (e) => {
      e.stopPropagation();
      this.openSubjectModal(subject.id);
    });
    card.querySelector('[data-delete]').addEventListener('click', (e) => {
      e.stopPropagation();
      this.deleteSubject(subject.id);
    });

    return card;
  }

  /* ----- Pendientes ----- */
  pendingItems() {
    const out = [];
    this.store.all().forEach((subject) => {
      subject.exams.forEach((item) => {
        if (isPending(item)) out.push({ ...item, kind: 'exam', subject });
      });
      subject.works.forEach((item) => {
        if (isPending(item)) out.push({ ...item, kind: 'work', subject });
      });
    });

    // Lo más próximo primero; lo que no tiene fecha, al final.
    return out.sort((a, b) => (a.date || '9999-12-31').localeCompare(b.date || '9999-12-31'));
  }

  dueLabel(iso) {
    if (!iso) return { text: 'Sin fecha', tone: 'warn' };
    const today = todayISO();
    const diff = Math.round(
      (new Date(iso + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000
    );
    if (!Number.isFinite(diff)) return { text: formatDate(iso), tone: 'warn' };
    if (diff < 0) return { text: diff === -1 ? 'Ayer' : `Hace ${Math.abs(diff)} días`, tone: 'bad' };
    if (diff === 0) return { text: 'Hoy', tone: 'warn' };
    if (diff === 1) return { text: 'Mañana', tone: 'warn' };
    return { text: `En ${diff} días`, tone: diff <= 7 ? 'warn' : 'ok' };
  }

  buildPendingRow(item) {
    const li = document.createElement('li');
    li.className = 'row pending-row';
    li.style.setProperty('--accent', item.subject.color);
    const isExam = item.kind === 'exam';
    const due = this.dueLabel(item.date);

    li.innerHTML = `
      <span class="row-kind ${isExam ? 'exam' : 'work'}"><span class="${isExam ? 'ico-exam' : 'ico-work'}"></span></span>
      <div class="row-main">
        <span class="row-title">${escapeHtml(item.name)}</span>
        <span class="row-sub">${escapeHtml(item.subject.name)} · ${isExam ? 'Examen' : 'Trabajo'}${item.date ? ' · ' + escapeHtml(formatDate(item.date)) : ''}</span>
      </div>
      <span class="badge-pill ${due.tone}">${due.text}</span>
      <button class="btn btn-quiet btn-sm pending-deliver" type="button" data-deliver>
        <span class="ico-check"></span><span class="btn-label">Finalizar</span>
      </button>
    `;

    li.querySelector('[data-deliver]').addEventListener('click', (e) => {
      e.stopPropagation();
      this.deliverItem(item.subject.id, item.kind, item.id);
    });

    li.addEventListener('click', () => {
      this.openDetail(item.subject.id);
      this.switchTab('evaluaciones');
    });

    return li;
  }

  renderPending() {
    const section = document.getElementById('pendientesSection');
    const list = document.getElementById('pendingList');
    if (!section || !list) return;

    const items = this.pendingItems();
    section.hidden = items.length === 0;
    list.innerHTML = '';
    if (!items.length) return;

    items.forEach((item) => list.appendChild(this.buildPendingRow(item)));
  }

  deliverItem(subjectId, kind, id) {
    const subject = this.store.get(subjectId);
    if (!subject) return;
    const items = kind === 'exam' ? subject.exams : subject.works;
    const item = items.find((i) => i.id === id);
    if (!item) return;

    item.done = true;
    this.store.save();
    this.store.currentId = subjectId;
    this.render();
    // Abrimos la evaluación para poner la nota (si ya la tiene, se queda tal cual).
    this.openItemModal(kind, id);
  }

  /* ----- Calendario ----- */
  calendarEvents() {
    const out = [];
    this.store.all().forEach((subject) => {
      subject.exams.forEach((e) => {
        if (e.date) out.push({ date: e.date, kind: 'exam', label: e.name, subject: subject, done: e.done });
      });
      subject.works.forEach((w) => {
        if (w.date) out.push({ date: w.date, kind: 'work', label: w.name, subject: subject, done: w.done });
      });
      subject.absences.forEach((a) => {
        if (a.date) out.push({ date: a.date, kind: 'absence', label: a.reason || (a.type === 'justificada' ? 'Falta justificada' : 'Falta injustificada'), subject: subject, absenceType: a.type });
      });
    });
    return out;
  }

  renderCalendar() {
    const grid = document.getElementById('calendarGrid');
    const title = document.getElementById('calTitle');
    const eventsEl = document.getElementById('calendarEvents');
    if (!grid || !title) return;

    const year = this.calYear;
    const month = this.calMonth;
    const monthName = new Date(year, month, 1).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
    title.textContent = monthName.charAt(0).toUpperCase() + monthName.slice(1);

    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startWeekday = (firstDay.getDay() + 6) % 7;

    const events = this.calendarEvents();
    const byDate = {};
    events.forEach((ev) => {
      if (!byDate[ev.date]) byDate[ev.date] = [];
      byDate[ev.date].push(ev);
    });

    const today = todayISO();
    const cells = [];
    for (let i = 0; i < startWeekday; i++) cells.push('<div class="cal-cell cal-blank"></div>');
    for (let d = 1; d <= lastDay.getDate(); d++) {
      const iso = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
      const evs = byDate[iso] || [];
      const isToday = iso === today;
      const dots = evs.map((ev) => {
        const cls = ev.kind === 'exam' ? 'dot-exam' : ev.kind === 'work' ? 'dot-work' : (ev.absenceType === 'justificada' ? 'dot-ok' : 'dot-bad');
        return '<span class="cal-dot ' + cls + '"></span>';
      }).join('');
      cells.push('<button class="cal-cell' + (isToday ? ' is-today' : '') + (evs.length ? ' has-events' : '') + '" type="button" data-date="' + iso + '"><span class="cal-day">' + d + '</span><span class="cal-dots">' + dots + '</span></button>');
    }
    const total = startWeekday + lastDay.getDate();
    const trailing = (7 - (total % 7)) % 7;
    for (let i = 0; i < trailing; i++) cells.push('<div class="cal-cell cal-blank"></div>');

    const weekdays = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
    grid.innerHTML = '<div class="cal-weekdays">' + weekdays.map((w) => '<div class="cal-wd">' + w + '</div>').join('') + '</div><div class="cal-days">' + cells.join('') + '</div>';

    grid.querySelectorAll('[data-date]').forEach((btn) => {
      btn.addEventListener('click', () => this.showCalendarDay(btn.dataset.date));
    });

    if (eventsEl) {
      const upcoming = events
        .filter((ev) => ev.date >= today)
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(0, 6);
      eventsEl.innerHTML = upcoming.length
        ? upcoming.map((ev) => '<div class="cal-event"><span class="row-kind ' + (ev.kind === 'exam' ? 'exam' : ev.kind === 'work' ? 'work' : 'absence') + '"><span class="' + (ev.kind === 'exam' ? 'ico-exam' : ev.kind === 'work' ? 'ico-work' : 'ico-note') + '"></span></span><div class="row-main"><span class="row-title">' + escapeHtml(ev.label) + '</span><span class="row-sub">' + escapeHtml(ev.subject.name) + ' · ' + formatDate(ev.date) + '</span></div></div>').join('')
        : '<p class="hint">Sin eventos proximos</p>';
    }
  }

  showCalendarDay(iso) {
    const events = this.calendarEvents().filter((ev) => ev.date === iso);
    const eventsEl = document.getElementById('calendarEvents');
    if (!eventsEl) return;
    if (!events.length) { eventsEl.innerHTML = '<p class="hint">Sin eventos este dia</p>'; return; }
    eventsEl.innerHTML = events.map((ev) => '<div class="cal-event"><span class="row-kind ' + (ev.kind === 'exam' ? 'exam' : ev.kind === 'work' ? 'work' : 'absence') + '"><span class="' + (ev.kind === 'exam' ? 'ico-exam' : ev.kind === 'work' ? 'ico-work' : 'ico-note') + '"></span></span><div class="row-main"><span class="row-title">' + escapeHtml(ev.label) + '</span><span class="row-sub">' + escapeHtml(ev.subject.name) + ' · ' + formatDate(ev.date) + '</span></div></div>').join('');
  }

  /* ----- Graficos ----- */
  renderGradeChart(subject) {
    const canvas = document.getElementById('gradeChart');
    const summary = document.getElementById('chartSummary');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 640;
    const cssH = 260;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);

    const items = subject.exams.map((i) => ({ ...i, kind: 'exam' })).concat(subject.works.map((i) => ({ ...i, kind: 'work' })))
      .filter((i) => hasGrade(i))
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    const padL = 32, padR = 12, padT = 16, padB = 46;
    const plotW = cssW - padL - padR;
    const plotH = cssH - padT - padB;

    ctx.strokeStyle = 'rgba(148,163,184,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, padT + plotH);
    ctx.lineTo(padL + plotW, padT + plotH);
    ctx.stroke();

    ctx.fillStyle = 'rgba(148,163,184,0.7)';
    ctx.font = '10px Inter, sans-serif';
    ctx.textAlign = 'right';
    [0, 5, 10].forEach((v) => {
      const y = padT + plotH - (v / 10) * plotH;
      ctx.fillText(String(v), padL - 6, y + 3);
      ctx.strokeStyle = 'rgba(148,163,184,0.12)';
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
    });

    if (!items.length) {
      ctx.fillStyle = 'rgba(148,163,184,0.6)';
      ctx.textAlign = 'center';
      ctx.fillText('Sin notas todavia', cssW / 2, cssH / 2);
      if (summary) summary.innerHTML = '<span class="mini-tag">Sin datos para graficar</span>';
      return;
    }

    const n = items.length;
    const gap = 6;
    const barW = Math.max(8, (plotW - gap * (n - 1)) / n);
    items.forEach((item, i) => {
      const grade = num(item.grade);
      const h = (grade / 10) * plotH;
      const x = padL + i * (barW + gap);
      const y = padT + plotH - h;
      ctx.fillStyle = item.kind === 'exam' ? '#22d3ee' : '#22c55e';
      ctx.fillRect(x, y, barW, h);
      ctx.fillStyle = 'rgba(248,249,252,0.7)';
      ctx.font = '9px Inter, sans-serif';
      ctx.textAlign = 'center';
      const label = String(item.name).slice(0, 8);
      ctx.save();
      ctx.translate(x + barW / 2, padT + plotH + 12);
      ctx.rotate(-Math.PI / 4);
      ctx.fillText(label, 0, 0);
      ctx.restore();
      ctx.fillStyle = 'rgba(248,249,252,0.9)';
      ctx.font = 'bold 9px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(grade.toFixed(1), x + barW / 2, y - 4);
    });

    if (summary) {
      const examAvg = weightedAverage(subject.exams);
      const workAvg = weightedAverage(subject.works);
      const final = finalGrade(subject);
      summary.innerHTML = ''
        + '<span class="mini-tag">Examen: ' + (examAvg === null ? '-' : examAvg.toFixed(2)) + '</span>'
        + '<span class="mini-tag">Trabajo: ' + (workAvg === null ? '-' : workAvg.toFixed(2)) + '</span>'
        + '<span class="mini-tag"><strong>Final: ' + (final === null ? '-' : final.toFixed(2)) + '</strong></span>';
    }
  }
  /* ----- Detalle ----- */
  bindDetail() {
    document.querySelectorAll('.tabs .tab').forEach((tab) => {
      tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
    });

    document.getElementById('editSubjectBtn').addEventListener('click', () => {
      if (this.store.currentId) this.openSubjectModal(this.store.currentId);
    });
    document.getElementById('railCloseBtn').addEventListener('click', () => this.closeModal('detailModal'));

    document.getElementById('addItemBtn').addEventListener('click', () => this.openItemModal());
    document.getElementById('addAbsenceBtn').addEventListener('click', () => this.openAbsenceModal());

    document.getElementById('itemFilters').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-item-filter]');
      if (!btn) return;
      this.itemFilter = btn.dataset.itemFilter;
      document.querySelectorAll('#itemFilters .filter').forEach((b) => {
        const active = b === btn;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', String(active));
      });
      this.renderItems(this.store.get(this.store.currentId));
    });

    document.querySelectorAll('input[name="setType"]').forEach((radio) => {
      radio.addEventListener('change', () => this.syncSettingsType());
    });

    ['setTotalClasses', 'setJustifiedPct', 'setUnjustifiedPct'].forEach((id) => {
      document.getElementById(id).addEventListener('input', () => this.updateLimitsHint());
    });
    ['setHoursPerWeek', 'setWeeks'].forEach((id) => {
      document.getElementById(id).addEventListener('input', () => this.updateHoursHint());
    });

    document.getElementById('saveSettingsBtn').addEventListener('click', () => this.saveSettings());
    document.getElementById('resetSettingsBtn').addEventListener('click', () => this.resetSettings());
    document.getElementById('deleteSubjectBtn').addEventListener('click', () => {
      if (this.store.currentId) this.deleteSubject(this.store.currentId);
    });
  }

  openDetail(id) {
    const subject = this.store.get(id);
    if (!subject) return;
    this.store.currentId = id;
    this.itemFilter = 'all';
    document.querySelectorAll('#itemFilters .filter').forEach((b) => {
      const active = b.dataset.itemFilter === 'all';
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', String(active));
    });
    this.fillDetail();
    this.switchTab('resumen');
    this.openModal('detailModal');
  }

  switchView(name) {
    this.currentView = name;
    document.querySelectorAll('.view-tab').forEach((t) => {
      const active = t.dataset.view === name;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('[data-view]').forEach((el) => {
      if (el.classList.contains('view-switcher')) return;
      el.style.display = (el.dataset.view === name) ? '' : 'none';
    });
  }

  switchTab(name) {
    document.querySelectorAll('.tabs .tab').forEach((t) => {
      const active = t.dataset.tab === name;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('is-active', p.dataset.pane === name));
    if (name === 'ajustes') this.fillSettings();
    if (name === 'graficos') {
      const subject = this.store.get(this.store.currentId);
      if (subject) this.renderGradeChart(subject);
    }
  }

  fillDetail() {
    const subject = this.store.get(this.store.currentId);
    if (!subject) return;

    const grade = finalGrade(subject);
    const examAvg = weightedAverage(subject.exams);
    const workAvg = weightedAverage(subject.works);
    const stats = absenceStats(subject);
    const type = TYPES[normalizeType(subject.type)];

    document.getElementById('detailTitle').textContent = subject.name;
    document.getElementById('detailSubtitle').textContent = type.short;
    document.getElementById('detailColor').style.background = subject.color;
    document.getElementById('detailColor').style.boxShadow = `0 0 0 4px ${subject.color}22`;

    /* Rail */
    const finalEl = document.getElementById('resFinal');
    finalEl.textContent = grade === null ? '—' : grade.toFixed(2);
    finalEl.style.color = grade === null ? '' : `var(--${gradeTone(grade)})`;

    const railRing = document.getElementById('railRing');
    railRing.style.strokeDashoffset = String(326.73 * (1 - (grade === null ? 0 : clamp(grade / 10, 0, 1))));
    railRing.style.stroke = grade === null ? 'var(--txt-3)' : `var(--${gradeTone(grade)})`;

    const pendingCount = [...subject.exams, ...subject.works].filter(isPending).length;
    document.getElementById('resFinalNote').textContent = grade === null
      ? (pendingCount
        ? `${pendingCount} pendiente${pendingCount === 1 ? '' : 's'}`
        : 'Sin evaluaciones')
      : `${subject.exams.length} exám. · ${subject.works.length} trab.${pendingCount ? ` · ${pendingCount} pend.` : ''}`;

    document.getElementById('railExams').textContent = examAvg === null ? '—' : examAvg.toFixed(2);
    document.getElementById('railWorks').textContent = workAvg === null ? '—' : workAvg.toFixed(2);
    document.getElementById('railAbsences').textContent = String(stats.total);
    document.getElementById('railAttendance').textContent = `${stats.attendance.toFixed(0)}%`;

    /* Resumen */
    document.getElementById('resTypeChip').textContent = type.label;

    const activeExams = normalizeType(subject.type) !== 'trabajos';
    const activeWorks = normalizeType(subject.type) !== 'examenes';
    const wE = activeExams ? Math.round(subject.weights.examenes) : 0;
    const wT = activeWorks ? Math.round(subject.weights.trabajos) : 0;

    document.getElementById('resWeightExams').textContent = `${wE}%`;
    document.getElementById('resWeightWorks').textContent = `${wT}%`;
    document.getElementById('meterExams').style.width = `${wE}%`;
    document.getElementById('meterWorks').style.width = `${wT}%`;
    document.getElementById('resExams').textContent = examAvg === null ? '—' : examAvg.toFixed(2);
    document.getElementById('resWorks').textContent = workAvg === null ? '—' : workAvg.toFixed(2);

    const formula = document.getElementById('resFormula');
    if (normalizeType(subject.type) === 'examenes') {
      formula.textContent = 'La nota final es la media ponderada de los exámenes.';
    } else if (normalizeType(subject.type) === 'trabajos') {
      formula.textContent = 'La nota final es la media ponderada de los trabajos.';
    } else if (examAvg === null || workAvg === null) {
      formula.textContent = `Falta ${examAvg === null ? 'algún examen' : 'algún trabajo'} para aplicar el ${wE}/${wT}. Se usa solo la parte con datos.`;
    } else {
      formula.textContent = `Exámenes × ${wE}% + trabajos × ${wT}% = nota final.`;
    }

    /* Asistencia */
    const attendanceChip = document.getElementById('resAttendanceChip');
    attendanceChip.textContent = `${stats.attendance.toFixed(0)}% asistencia`;

    document.getElementById('resJustifiedText').textContent = `${stats.justified} / ${prettyNumber(stats.maxJ)}`;
    document.getElementById('resUnjustifiedText').textContent = `${stats.unjustified} / ${prettyNumber(stats.maxU)}`;

    const jBar = document.getElementById('resJustifiedBar');
    const uBar = document.getElementById('resUnjustifiedBar');
    jBar.style.width = `${stats.maxJ > 0 ? clamp((stats.justified / stats.maxJ) * 100, 0, 100) : (stats.justified ? 100 : 0)}%`;
    uBar.style.width = `${stats.maxU > 0 ? clamp((stats.unjustified / stats.maxU) * 100, 0, 100) : (stats.unjustified ? 100 : 0)}%`;
    jBar.className = `bar-fill ${stats.jOver ? 'fill-bad' : 'fill-ok'}`;
    uBar.className = `bar-fill ${stats.uOver ? 'fill-bad' : 'fill-warn'}`;

    const hint = document.getElementById('resAttendanceHint');
    if (stats.uOver) {
      hint.textContent = `Te has pasado del límite de injustificadas (${prettyNumber(stats.maxU)}).`;
      hint.className = 'hint is-bad';
    } else if (stats.jOver) {
      hint.textContent = `Te has pasado del límite de justificadas (${prettyNumber(stats.maxJ)}).`;
      hint.className = 'hint is-warn';
    } else {
      hint.textContent = `${stats.total} falta(s) sobre ${stats.classes} clases · límites: ${subject.attendance.justifiedPct}% J / ${subject.attendance.unjustifiedPct}% I.`;
      hint.className = 'hint';
    }

    /* Contadores */
    document.getElementById('tabCountItems').textContent = String(subject.exams.length + subject.works.length);
    document.getElementById('tabCountAbsences').textContent = String(stats.total);

    /* Faltas: tarjetas */
    document.getElementById('absJustified').textContent = String(stats.justified);
    document.getElementById('absUnjustified').textContent = String(stats.unjustified);
    document.getElementById('absTotal').textContent = String(stats.total);
    document.getElementById('absJustifiedLimit').textContent = `límite ${prettyNumber(stats.maxJ)}`;
    document.getElementById('absUnjustifiedLimit').textContent = `límite ${prettyNumber(stats.maxU)}`;
    document.getElementById('absTotalNote').textContent = `de ${stats.classes} clases`;

    this.renderItems(subject);
    this.renderAbsences(subject);
    this.renderGradeChart(subject);
  }

  /* ----- Evaluaciones ----- */
  combinedItems(subject) {
    const exams = subject.exams.map((i) => ({ ...i, kind: 'exam' }));
    const works = subject.works.map((i) => ({ ...i, kind: 'work' }));
    const all = [...exams, ...works];

    // Primero lo pendiente (lo más próximo antes) y después lo ya entregado (más reciente antes).
    return all.sort((a, b) => {
      const pa = isPending(a) ? 0 : 1;
      const pb = isPending(b) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      const da = a.date || '9999-12-31';
      const db = b.date || '9999-12-31';
      return pa === 0 ? da.localeCompare(db) : db.localeCompare(da);
    });
  }

  renderItems(subject) {
    if (!subject) return;
    const list = document.getElementById('itemsList');
    const empty = document.getElementById('itemsEmpty');
    list.innerHTML = '';

    let items = this.combinedItems(subject);
    if (this.itemFilter !== 'all') items = items.filter((i) => i.kind === this.itemFilter);

    const total = subject.exams.length + subject.works.length;
    empty.classList.toggle('is-visible', items.length === 0);
    list.style.display = items.length ? '' : 'none';
    empty.querySelector('p').textContent = total === 0
      ? 'Sin evaluaciones todavía'
      : 'No hay evaluaciones de este tipo';

    // El peso que se muestra es el que cuenta ahora mismo (solo entregadas con nota).
    const counted = {
      exam: subject.exams.filter(countsForGrade),
      work: subject.works.filter(countsForGrade)
    };
    const weights = {
      exam: effectiveWeights(counted.exam),
      work: effectiveWeights(counted.work)
    };

    items.forEach((item) => {
      const index = counted[item.kind].findIndex((i) => i.id === item.id);
      list.appendChild(this.buildItemRow(item, index >= 0 ? weights[item.kind][index] : null));
    });

    this.renderWeightTotals(subject);
  }

  buildItemRow(item, effectiveWeight = null) {
    const li = document.createElement('li');
    const pending = isPending(item);
    li.className = 'row' + (pending ? ' is-pending' : '');
    const tone = hasGrade(item) ? gradeTone(num(item.grade)) : 'neutral';
    const isExam = item.kind === 'exam';
    const auto = num(item.weight, 0) <= 0;
    const gradeText = hasGrade(item) ? num(item.grade).toFixed(1) : '—';
    const weightText = effectiveWeight === null || effectiveWeight === undefined
      ? '—'
      : `${prettyNumber(effectiveWeight)}%${auto ? '*' : ''}`;

    li.innerHTML = `
      <span class="row-kind ${isExam ? 'exam' : 'work'}"><span class="${isExam ? 'ico-exam' : 'ico-work'}"></span></span>
      <div class="row-main">
        <span class="row-title">${escapeHtml(item.name)}</span>
        <span class="row-sub">${isExam ? 'Examen' : 'Trabajo'}${item.date ? ' · ' + escapeHtml(formatDate(item.date)) : ''}${pending ? ' · <span class="badge-pill warn">Pendiente</span>' : ''}</span>
      </div>
      <span class="row-grade ${tone === 'ok' ? 'is-ok' : tone === 'warn' ? 'is-warn' : tone === 'bad' ? 'is-bad' : ''}">${gradeText}</span>
      <span class="row-weight${auto ? ' is-auto' : ''}" title="${effectiveWeight === null ? 'Aún no cuenta para la media' : (auto ? 'Peso automático: reparto de lo que falta' : 'Peso asignado')}">${weightText}</span>
      <div class="row-actions">
        <button class="icon-btn" type="button" data-edit aria-label="Editar"><span class="ico-pen"></span></button>
        <button class="icon-btn" type="button" data-del aria-label="Eliminar"><span class="ico-trash"></span></button>
      </div>
    `;

    li.querySelector('[data-edit]').addEventListener('click', () => this.openItemModal(item.kind, item.id));
    li.querySelector('[data-del]').addEventListener('click', () => this.deleteItem(item.kind, item.id));
    return li;
  }

  renderWeightTotals(subject) {
    const config = [
      { id: 'examsTotalLine', items: subject.exams, label: 'exámenes' },
      { id: 'worksTotalLine', items: subject.works, label: 'trabajos' }
    ];

    config.forEach(({ id, items, label }) => {
      const el = document.getElementById(id);
      if (!items.length) {
        el.classList.remove('is-visible');
        return;
      }

      el.classList.add('is-visible');
      const counted = items.filter(countsForGrade);

      if (!counted.length) {
        el.classList.remove('is-bad');
        el.innerHTML = `<span>Peso de ${label}</span><strong>Sin notas todavía</strong>`;
        return;
      }

      const assigned = counted.reduce((acc, i) => acc + Math.max(0, num(i.weight, 0)), 0);
      const autoItems = counted.filter((i) => num(i.weight, 0) <= 0);
      const share = autoItems.length ? Math.max(0, 100 - assigned) / autoItems.length : 0;

      if (!autoItems.length) {
        const diff = 100 - assigned;
        el.classList.toggle('is-bad', Math.abs(diff) > 0.01);

        if (Math.abs(diff) < 0.01) {
          el.innerHTML = `<span>Peso total de ${label}</span><strong>100%</strong>`;
        } else if (diff > 0) {
          el.innerHTML = `<span>Peso total de ${label}</span><strong>${prettyNumber(assigned)}% · faltan ${prettyNumber(diff)}%</strong>`;
        } else {
          el.innerHTML = `<span>Peso total de ${label}</span><strong>${prettyNumber(assigned)}% · sobran ${prettyNumber(Math.abs(diff))}%</strong>`;
        }
        return;
      }

      if (share <= 0) {
        el.classList.add('is-bad');
        el.innerHTML = `<span>Peso total de ${label}</span><strong>${prettyNumber(assigned)}% · sobran ${prettyNumber(assigned - 100)}%</strong>`;
        return;
      }

      el.classList.remove('is-bad');
      el.innerHTML = `<span>${prettyNumber(assigned)}% asignado · ${prettyNumber(100 - assigned)}% automático</span><strong>${prettyNumber(share)}% c/u</strong>`;
    });
  }

  bindItemModal() {
    document.getElementById('itemForm').addEventListener('submit', (e) => {
      e.preventDefault();
      this.saveItem();
    });

    document.querySelectorAll('input[name="itemKind"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        this.itemKind = radio.value;
        this.updateItemModalLabels();
        this.updateItemHint();
      });
    });

    document.getElementById('itemWeight').addEventListener('input', () => this.updateItemHint());

    // Si la fecha es futura, la evaluación se marca como pendiente automáticamente.
    document.getElementById('itemDate').addEventListener('change', () => {
      const done = document.getElementById('itemDone');
      if (!done) return;
      const date = document.getElementById('itemDate').value;
      done.checked = !date || date <= todayISO();
    });
  }

  openItemModal(kind = null, itemId = null) {
    const subject = this.store.get(this.store.currentId);
    if (!subject) return;

    const type = normalizeType(subject.type);
    const forced = type === 'examenes' ? 'exam' : type === 'trabajos' ? 'work' : null;
    const editing = itemId
      ? (kind === 'work' ? subject.works : subject.exams).find((i) => i.id === itemId)
      : null;

    this.itemKind = editing ? (kind === 'work' ? 'work' : 'exam') : (forced || kind || 'exam');

    const kindField = document.getElementById('itemKindField');
    const lockHint = document.getElementById('itemKindLock');
    if (forced) {
      kindField.style.display = 'none';
      lockHint.textContent = `Esta materia se evalúa solo con ${forced === 'exam' ? 'exámenes' : 'trabajos'}, así que la evaluación se guardará como ${forced === 'exam' ? 'examen' : 'trabajo'}.`;
      lockHint.className = 'hint';
    } else {
      kindField.style.display = '';
      lockHint.textContent = '';
    }

    document.querySelectorAll('input[name="itemKind"]').forEach((radio) => {
      radio.checked = radio.value === this.itemKind;
      radio.disabled = Boolean(forced);
    });

    document.getElementById('itemId').value = editing ? editing.id : '';
    document.getElementById('itemName').value = editing ? editing.name : '';
    document.getElementById('itemGrade').value = editing && editing.grade !== null ? editing.grade : '';
    document.getElementById('itemWeight').value = editing && num(editing.weight, 0) > 0 ? editing.weight : '';
    document.getElementById('itemDate').value = editing ? editing.date : todayISO();
    document.getElementById('itemDone').checked = editing ? editing.done !== false : true;
    document.getElementById('itemSubmit').textContent = editing ? 'Guardar cambios' : 'Añadir';

    this.updateItemModalLabels();
    this.updateItemHint();
    this.openModal('itemModal');
  }

  updateItemModalLabels() {
    const isExam = this.itemKind === 'exam';
    const kindField = document.getElementById('itemKindField');
    const editing = Boolean(document.getElementById('itemId').value);
    document.getElementById('itemModalTitle').textContent = (editing ? 'Editar ' : 'Añadir ') + (isExam ? 'examen' : 'trabajo');
    document.getElementById('itemNameLabel').textContent = isExam ? 'Nombre del examen' : 'Nombre del trabajo';
    document.getElementById('itemName').placeholder = isExam ? 'Ej. Examen tema 1' : 'Ej. Práctica 2';
    if (kindField.style.display === 'none') {
      document.getElementById('itemModalTitle').textContent = (editing ? 'Editar ' : 'Añadir ') + (isExam ? 'examen' : 'trabajo');
    }
  }

  updateItemHint() {
    const subject = this.store.get(this.store.currentId);
    if (!subject) return;
    const items = this.itemKind === 'exam' ? subject.exams : subject.works;
    const editingId = document.getElementById('itemId').value;
    const others = items.filter((i) => i.id !== editingId);
    const used = others.reduce((acc, i) => acc + Math.max(0, num(i.weight, 0)), 0);
    const remaining = Math.max(0, 100 - used);
    const hint = document.getElementById('itemHint');

    if (!others.length) {
      hint.textContent = 'Si es la única evaluación, se queda con el 100%. Puedes dejar el peso vacío.';
      hint.className = 'hint';
      return;
    }

    hint.textContent = `Ya hay ${prettyNumber(used)}% asignado en ${this.itemKind === 'exam' ? 'exámenes' : 'trabajos'}. Quedan ${prettyNumber(remaining)}%. Si dejas el peso vacío, se reparte automáticamente entre las que no tengan peso.`;
    hint.className = remaining <= 0 ? 'hint is-warn' : 'hint';
  }

  saveItem() {
    const subject = this.store.get(this.store.currentId);
    if (!subject) return;

    const id = document.getElementById('itemId').value;
    const name = document.getElementById('itemName').value.trim();
    const gradeRaw = document.getElementById('itemGrade').value.trim();
    const weightRaw = document.getElementById('itemWeight').value.trim();
    const grade = gradeRaw === '' ? null : num(gradeRaw, NaN);
    const weight = weightRaw === '' ? 0 : num(weightRaw, NaN);
    const date = document.getElementById('itemDate').value;
    const done = document.getElementById('itemDone').checked;

    if (!name) { toast('Falta el nombre', true); return; }
    if (grade !== null && (!Number.isFinite(grade) || grade < 0 || grade > 10)) {
      toast('La nota debe estar entre 0 y 10', true);
      return;
    }
    if (!Number.isFinite(weight) || weight < 0 || weight > 100) {
      toast('El peso debe estar entre 0 y 100', true);
      return;
    }

    const type = normalizeType(subject.type);
    const checkedKind = document.querySelector('input[name="itemKind"]:checked');
    const chosenKind = checkedKind ? checkedKind.value : this.itemKind;
    const kind = type === 'examenes' ? 'exam' : type === 'trabajos' ? 'work' : chosenKind;
    const items = kind === 'exam' ? subject.exams : subject.works;
    const payload = { id: id || uid(), name, grade, weight, date, done };

    if (id) {
      const index = items.findIndex((i) => i.id === id);
      if (index >= 0) items[index] = payload;
      else items.push(payload);
      // si al editar cambia de tipo, quitar del array antiguo
      const other = kind === 'exam' ? subject.works : subject.exams;
      const otherIndex = other.findIndex((i) => i.id === id);
      if (otherIndex >= 0 && index < 0) other.splice(otherIndex, 1);
    } else {
      items.push(payload);
    }

    this.itemKind = kind;
    this.store.save();
    this.closeModal('itemModal');
    this.fillDetail();
    this.render();
    toast(id
      ? 'Cambios guardados'
      : (!done
        ? 'Guardada como pendiente'
        : (grade === null
          ? 'Guardada como finalizada (sin nota)'
          : (kind === 'exam' ? 'Examen añadido' : 'Trabajo añadido'))));
  }

  deleteItem(kind, id) {
    const subject = this.store.get(this.store.currentId);
    if (!subject) return;
    const items = kind === 'exam' ? subject.exams : subject.works;
    const index = items.findIndex((i) => i.id === id);
    if (index < 0) return;
    const removed = items[index];

    if (kind === 'exam') subject.exams.splice(index, 1);
    else subject.works.splice(index, 1);

    this.store.save();
    this.fillDetail();
    this.render();

    toast('Evaluación eliminada', false, () => {
      const s = this.store.get(this.store.currentId);
      if (!s) return;
      if (kind === 'exam') s.exams.splice(index, 0, removed);
      else s.works.splice(index, 0, removed);
      this.store.save();
      this.fillDetail();
      this.render();
    });
  }

  /* ----- Faltas ----- */
  bindAbsenceModal() {
    document.getElementById('absenceForm').addEventListener('submit', (e) => {
      e.preventDefault();
      this.saveAbsence();
    });
  }

  openAbsenceModal(id = null) {
    const subject = this.store.get(this.store.currentId);
    if (!subject) return;
    const absence = id ? subject.absences.find((a) => a.id === id) : null;

    document.getElementById('absenceModalTitle').textContent = absence ? 'Editar falta' : 'Añadir falta';
    document.getElementById('absenceId').value = absence ? absence.id : '';
    document.getElementById('absenceDate').value = absence ? absence.date : todayISO();
    document.getElementById('absenceReason').value = absence ? absence.reason : '';
    document.querySelectorAll('input[name="absenceKind"]').forEach((radio) => {
      radio.checked = radio.value === (absence ? absence.type : 'justificada');
    });

    this.openModal('absenceModal');
  }

  saveAbsence() {
    const subject = this.store.get(this.store.currentId);
    if (!subject) return;

    const id = document.getElementById('absenceId').value;
    const date = document.getElementById('absenceDate').value;
    const reason = document.getElementById('absenceReason').value.trim();
    const type = document.querySelector('input[name="absenceKind"]:checked')?.value || 'justificada';

    if (!date) { toast('Elige una fecha', true); return; }

    const payload = { id: id || uid(), date, reason, type };
    if (id) {
      const index = subject.absences.findIndex((a) => a.id === id);
      if (index >= 0) subject.absences[index] = payload;
      else subject.absences.push(payload);
    } else {
      subject.absences.push(payload);
    }

    this.store.save();
    this.closeModal('absenceModal');
    this.fillDetail();
    this.render();
    toast(id ? 'Falta actualizada' : 'Falta añadida');
  }

  renderAbsences(subject) {
    const list = document.getElementById('absencesList');
    const empty = document.getElementById('absencesEmpty');
    list.innerHTML = '';

    const sorted = [...subject.absences].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    empty.classList.toggle('is-visible', sorted.length === 0);
    list.style.display = sorted.length ? '' : 'none';

    sorted.forEach((absence) => {
      const justified = absence.type === 'justificada';
      const li = document.createElement('li');
      li.className = 'row';
      li.innerHTML = `
        <span class="row-kind ${justified ? 'work' : 'exam'}">
          <span class="${justified ? 'ico-check' : 'ico-x'}"></span>
        </span>
        <div class="row-main">
          <span class="row-title">${escapeHtml(absence.reason || 'Sin motivo')}</span>
          <span class="row-sub">${absence.date ? escapeHtml(formatLongDate(absence.date)) : 'Sin fecha'}</span>
        </div>
        <span class="badge-pill ${justified ? 'ok' : 'warn'}">${justified ? 'Justificada' : 'Injustificada'}</span>
        <div class="row-actions">
          <button class="icon-btn" type="button" data-edit aria-label="Editar"><span class="ico-pen"></span></button>
          <button class="icon-btn" type="button" data-del aria-label="Eliminar"><span class="ico-trash"></span></button>
        </div>
      `;
      li.querySelector('[data-edit]').addEventListener('click', () => this.openAbsenceModal(absence.id));
      li.querySelector('[data-del]').addEventListener('click', () => this.deleteAbsence(absence.id));
      list.appendChild(li);
    });
  }

  deleteAbsence(id) {
    const subject = this.store.get(this.store.currentId);
    if (!subject) return;
    if (!window.confirm('¿Eliminar esta falta?')) return;
    subject.absences = subject.absences.filter((a) => a.id !== id);
    this.store.save();
    this.fillDetail();
    this.render();
    toast('Falta eliminada');
  }

  /* ----- Ajustes ----- */
  fillSettings() {
    const subject = this.store.get(this.store.currentId);
    if (!subject) return;
    const type = normalizeType(subject.type);

    document.querySelectorAll('input[name="setType"]').forEach((radio) => {
      radio.checked = radio.value === type;
    });

    document.getElementById('setExamWeight').value = Math.round(subject.weights.examenes);
    document.getElementById('setWorkWeight').value = Math.round(subject.weights.trabajos);
    document.getElementById('setTotalClasses').value = subject.attendance.totalClasses;
    document.getElementById('setHoursPerWeek').value = subject.attendance.hoursPerWeek ?? '';
    document.getElementById('setWeeks').value = subject.attendance.weeks ?? '';
    document.getElementById('setJustifiedPct').value = subject.attendance.justifiedPct ?? 15;
    document.getElementById('setUnjustifiedPct').value = subject.attendance.unjustifiedPct ?? 10;

    this.syncSettingsType();
    this.updateLimitsHint();
    this.updateHoursHint();
  }

  syncSettingsType() {
    const type = this.selectedType('setType');
    const row = document.getElementById('weightsRow');
    const hint = document.getElementById('weightsHint');

    if (type === 'mixto') {
      row.style.display = '';
      hint.textContent = 'Exámenes + trabajos debe sumar 100%.';
      hint.className = 'hint';
    } else {
      row.style.display = 'none';
      hint.textContent = type === 'examenes'
        ? 'La nota final usará solo exámenes.'
        : 'La nota final usará solo trabajos.';
      hint.className = 'hint';
    }
  }

  updateHoursHint() {
    const hpw = num(document.getElementById('setHoursPerWeek').value);
    const weeks = num(document.getElementById('setWeeks').value);
    const total = hpw * weeks;
    const classesInput = document.getElementById('setTotalClasses');
    const hint = document.getElementById('hoursHint');
    if (hpw > 0 && weeks > 0 && total > 0) {
      classesInput.value = Math.round(total);
      hint.textContent = `Horas totales calculadas: ${Math.round(total)} clases/horas aproximadamente.`;
    } else {
      hint.textContent = 'Pon horas por semana y semanas para calcular el total automáticamente.';
    }
    this.updateLimitsHint();
  }

  updateLimitsHint() {
    const classes = clamp(num(document.getElementById('setTotalClasses').value, 30), 1, 400);
    const jPct = clamp(num(document.getElementById('setJustifiedPct').value), 0, 100);
    const uPct = clamp(num(document.getElementById('setUnjustifiedPct').value), 0, 100);
    document.getElementById('limitsHint').textContent =
      `Con ${classes} clases: hasta ${prettyNumber((classes * jPct) / 100)} justificadas y ${prettyNumber((classes * uPct) / 100)} injustificadas.`;
  }

  saveSettings() {
    const subject = this.store.get(this.store.currentId);
    if (!subject) return;

    const type = this.selectedType('setType');
    let examenes = clamp(num(document.getElementById('setExamWeight').value), 0, 100);
    let trabajos = clamp(num(document.getElementById('setWorkWeight').value), 0, 100);

    if (type === 'examenes') { examenes = 100; trabajos = 0; }
    else if (type === 'trabajos') { examenes = 0; trabajos = 100; }
    else if (Math.abs(examenes + trabajos - 100) > 0.01) {
      toast('Exámenes + trabajos debe sumar 100%', true);
      return;
    }

    subject.type = type;
    subject.weights = { examenes, trabajos };
    subject.attendance = {
      totalClasses: clamp(num(document.getElementById('setTotalClasses').value, 30), 1, 400),
      hoursPerWeek: num(document.getElementById('setHoursPerWeek').value) || undefined,
      weeks: num(document.getElementById('setWeeks').value) || undefined,
      justifiedPct: clamp(num(document.getElementById('setJustifiedPct').value), 0, 100),
      unjustifiedPct: clamp(num(document.getElementById('setUnjustifiedPct').value), 0, 100)
    };

    this.store.save();
    this.fillDetail();
    this.fillSettings();
    this.render();
    toast('Ajustes guardados');
  }

  resetSettings() {
    const subject = this.store.get(this.store.currentId);
    if (!subject) return;
    if (!window.confirm('¿Restablecer los ajustes de esta materia?')) return;

    const d = DEFAULTS();
    subject.type = 'mixto';
    subject.weights = d.weights;
    subject.attendance = d.attendance;

    this.store.save();
    this.fillDetail();
    this.fillSettings();
    this.render();
    toast('Ajustes restablecidos');
  }

  /* ----- Datos ----- */
  exportData() {
    const payload = {
      app: 'notas-faltas',
      version: 3,
      exportedAt: new Date().toISOString(),
      subjects: this.store.all()
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `notas-faltas-${todayISO()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
    toast('Copia de seguridad descargada');
  }

  importData(event) {
    const input = event.target;
    const file = input.files && input.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        const list = Array.isArray(parsed) ? parsed : parsed.subjects;
        if (!Array.isArray(list)) throw new Error('Formato no válido');

        const imported = this.store.sanitize(list);
        if (!imported.length) throw new Error('Sin materias');

        const replace = this.store.all().length === 0
          ? true
          : window.confirm('Aceptar = reemplazar tus datos actuales.\nCancelar = añadir las materias del archivo.');

        this.store.subjects = replace ? imported : this.store.sanitize([...this.store.all(), ...imported]);
        this.store.save();
        this.render();
        toast(replace ? 'Datos importados' : 'Materias añadidas');
      } catch (err) {
        console.error(err);
        toast('Archivo no válido', true);
      } finally {
        input.value = '';
      }
    };
    reader.onerror = () => {
      toast('No se pudo leer el archivo', true);
      input.value = '';
    };
    reader.readAsText(file);
  }

  /* ----- Sincronización (Appwrite) ----- */
  bindSync() {
    ['syncBtn', 'mobileSyncBtn'].forEach((id) => {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.addEventListener('click', () => {
        const sheet = document.getElementById('mobileMoreSheet');
        if (sheet) sheet.classList.remove('is-open');
        this.openSyncModal();
      });
    });

    const send = document.getElementById('syncSendMagic');
    if (send) send.addEventListener('click', () => this.sendMagicLink());

    const logout = document.getElementById('syncLogout');
    if (logout) logout.addEventListener('click', () => this.logoutSync());

    const now = document.getElementById('syncNow');
    if (now) now.addEventListener('click', () => this.syncNow(true));

    const email = document.getElementById('syncEmail');
    if (email) {
      email.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.sendMagicLink();
        }
      });
    }

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && appwriteSyncEnabled) this.syncNow(false);
    });
    window.addEventListener('online', () => {
      if (appwriteSyncEnabled) this.syncNow(false);
    });
  }

  openSyncModal() {
    const modal = document.getElementById('syncModal');
    if (!modal) return;
    this.openModal('syncModal');
    this.refreshSyncUi();
  }

  async refreshSyncUi() {
    const user = await getAppwriteUser();
    const loggedOut = document.getElementById('syncLoggedOut');
    const loggedIn = document.getElementById('syncLoggedIn');
    const emailEl = document.getElementById('syncUserEmail');

    appwriteSyncEnabled = Boolean(user);

    if (user) {
      if (loggedOut) loggedOut.style.display = 'none';
      if (loggedIn) loggedIn.style.display = 'block';
      if (emailEl) emailEl.textContent = user.email || '';
      this.setSyncLabel('Sincronizado');
    } else {
      if (loggedOut) loggedOut.style.display = 'block';
      if (loggedIn) loggedIn.style.display = 'none';
      this.setSyncLabel('Sincronizar');
    }
  }

  setSyncLabel(text) {
    const lbl = document.getElementById('syncBtnLabel');
    if (lbl) lbl.textContent = text;
  }

  async sendMagicLink() {
    if (!appwriteAccount) {
      toast('Sincronización no disponible ahora mismo', true);
      return;
    }
    const input = document.getElementById('syncEmail');
    const email = input ? input.value.trim() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast('Escribe un email válido', true);
      if (input) input.focus();
      return;
    }

    const btn = document.getElementById('syncSendMagic');
    if (btn) { btn.disabled = true; btn.textContent = 'Enviando…'; }

    try {
      const url = window.location.origin + window.location.pathname;
      await appwriteAccount.createMagicURLToken({ userId: 'unique()', email, url });
      toast('Enlace enviado. Revisa tu correo.');
      if (input) input.value = '';
    } catch (err) {
      console.error(err);
      toast(err && err.message ? 'No se pudo enviar: ' + err.message : 'No se pudo enviar el enlace', true);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Enviar enlace mágico'; }
    }
  }

  async logoutSync() {
    if (!appwriteAccount) return;
    try {
      await appwriteAccount.deleteSession({ sessionId: 'current' });
    } catch (err) {
      console.warn('No se pudo cerrar sesión', err);
    }
    appwriteCurrentUser = null;
    appwriteSyncEnabled = false;
    this.setSyncLabel('Sincronizar');
    this.closeModal('syncModal');
    toast('Sesión cerrada');
  }

  async syncNow(manual = false) {
    if (!appwriteAccount) {
      if (manual) toast('Sincronización no disponible ahora mismo', true);
      return;
    }
    if (syncInFlight) return;

    const user = appwriteCurrentUser || await getAppwriteUser();
    if (!user) {
      if (manual) this.openSyncModal();
      return;
    }

    syncInFlight = true;
    if (manual) this.setSyncLabel('Sincronizando…');

    try {
      let remote = null;
      const raw = user.prefs && user.prefs.peak;
      if (raw) {
        try { remote = JSON.parse(raw); } catch (err) { remote = null; }
      }
      const localModified = parseInt(localStorage.getItem(MODIFIED_KEY) || '0', 10) || 0;
      const remoteTime = (remote && Number(remote.savedAt)) || 0;

      if (!remote) {
        if (this.store.all().length) {
          await this.pushToCloud(user);
          if (manual) toast('Datos subidos a la nube');
        } else if (manual) {
          toast('Todavía no hay datos que sincronizar');
        }
      } else if (localModified > remoteTime) {
        await this.pushToCloud(user);
        if (manual) toast('Datos subidos a la nube');
      } else {
        const changed = this.applyCloudPayload(remote);
        if (manual) toast(changed ? 'Datos actualizados desde la nube' : 'Todo está al día');
      }

      this.setSyncLabel('Sincronizado');
      const status = document.getElementById('syncStatus');
      if (status) {
        status.textContent = 'Última sincronización: ' +
          new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
      }
    } catch (err) {
      console.error('Error de sincronización', err);
      this.setSyncLabel('Error al sincronizar');
      if (manual) {
        toast(err && err.message ? 'Error: ' + err.message : 'No se pudo sincronizar', true);
      }
    } finally {
      syncInFlight = false;
    }
  }

  schedulePush() {
    if (!appwriteSyncEnabled) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => this.syncNow(false), 2000);
  }

  async pushToCloud(user) {
    const savedAt = Date.now();
    const payload = { v: 1, savedAt, subjects: this.store.all() };
    const json = JSON.stringify(payload);

    try {
      await appwriteAccount.updatePrefs({ prefs: { peak: json } });
      user.prefs = { peak: json };
    } catch (err) {
      if (String((err && err.message) || '').toLowerCase().includes('size')) {
        toast('Hay demasiados datos para la nube. Descarga una copia de seguridad.', true);
      }
      throw err;
    }

    localStorage.setItem(MODIFIED_KEY, String(savedAt));
  }

  applyCloudPayload(payload) {
    const subjects = this.store.sanitize(payload && payload.subjects);
    const after = JSON.stringify(subjects);
    const savedAt = String((payload && payload.savedAt) || Date.now());

    if (JSON.stringify(this.store.all()) === after) {
      localStorage.setItem(MODIFIED_KEY, savedAt);
      return false;
    }

    this.store.subjects = subjects;
    try {
      localStorage.setItem(STORAGE_KEY, after);
      localStorage.setItem(MODIFIED_KEY, savedAt);
    } catch (err) {
      console.warn('No se pudieron guardar los datos descargados', err);
    }
    this.render();
    return true;
  }

  async checkSyncOnLoad() {
    if (!appwriteAccount) return;
    const user = await getAppwriteUser();
    if (!user) return;
    appwriteSyncEnabled = true;
    this.setSyncLabel('Sincronizado');
    this.syncNow(false);
  }
}

/* ---------- Enlace mágico ---------- */
async function completeMagicLink() {
  if (!appwriteAccount) return;

  const params = new URLSearchParams(window.location.search);
  const userId = params.get('userId');
  const secret = params.get('secret');
  if (!userId || !secret) return;

  try {
    await appwriteAccount.createSession({ userId, secret });
    toast('Sesión iniciada. Sincronizando…');
  } catch (err) {
    console.warn('Enlace mágico no válido', err);
    toast('El enlace ha caducado. Pide uno nuevo.', true);
  } finally {
    params.delete('userId');
    params.delete('secret');
    const qs = params.toString();
    const clean = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
    try { window.history.replaceState({}, '', clean); } catch (err) { /* ignora */ }
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  initAppwrite();
  await completeMagicLink();
  if (!window.app) window.app = new App();
});
