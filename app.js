/* app.js — nối CanLogic ↔ DOM ↔ localStorage. Không chứa công thức tính (công thức ở can-logic.js). */
(function () {
  'use strict';
  var L = window.CanLogic;
  var DB = window.FOODS_DB;
  var KEY = 'giam-can';
  var THEME_KEY = 'giam-can-theme';
  var state;
  var viewDate = L.todayStr(); // ngày đang xem ở tab Hôm nay (không lưu)
  var activeTab = 'homnay';
  var sheetMeal = 'sang';      // bữa đang thêm món
  var chartRange = 30;         // 30 | 90 | 0 (tất cả)

  // ── Tiện ích DOM ──────────────────────────────────────
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (attrs[k] == null || attrs[k] === false) return;
      if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function fmtNum(n) { return Math.round(n).toLocaleString('vi-VN'); }
  var toastTimer;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 2000);
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  // ── Lưu / nạp / transaction ───────────────────────────
  function save() { localStorage.setItem(KEY, JSON.stringify(state)); }
  // Chuẩn hoá state từ mọi nguồn (localStorage cũ, file import) → không thiếu trường, lọc rác.
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  function normalize(s) {
    if (!s || typeof s !== 'object') throw new Error('Dữ liệu không đúng định dạng');
    if (typeof s.schemaVersion === 'number' && s.schemaVersion > L.SCHEMA_VERSION)
      throw new Error('File này từ phiên bản app mới hơn — hãy cập nhật app trước.');
    var base = L.createState();
    var out = Object.assign({}, base, s);
    out.schemaVersion = L.SCHEMA_VERSION;

    out.profile = (s.profile && typeof s.profile === 'object') ? {
      sex: s.profile.sex === 'female' ? 'female' : 'male',
      age: clampNum(s.profile.age, 10, 100),
      heightCm: clampNum(s.profile.heightCm, 100, 230),
      activity: L.ACTIVITY_LEVELS.indexOf(Number(s.profile.activity)) >= 0 ? Number(s.profile.activity) : 1.375,
    } : null;
    if (out.profile && (out.profile.age == null || out.profile.heightCm == null)) out.profile = null;

    out.goal = (s.goal && typeof s.goal === 'object') ? {
      targetWeightKg: clampNum(s.goal.targetWeightKg, 20, 300),
      deficitKgPerWeek: [0.25, 0.5, 0.75].indexOf(Number(s.goal.deficitKgPerWeek)) >= 0 ? Number(s.goal.deficitKgPerWeek) : 0.5,
      startWeightKg: clampNum(s.goal.startWeightKg, 20, 300),
      startDate: DATE_RE.test(s.goal.startDate) ? s.goal.startDate : L.todayStr(),
    } : null;
    if (out.goal && out.goal.targetWeightKg == null) out.goal = null;

    out.weights = Array.isArray(s.weights) ? s.weights.filter(function (w) {
      return w && DATE_RE.test(w.date) && Number.isFinite(Number(w.kg)) && w.kg > 0;
    }).map(function (w) { return { date: w.date, kg: Number(w.kg) }; }) : [];
    out.weights.sort(function (a, b) { return a.date < b.date ? -1 : 1; });

    out.log = {};
    if (s.log && typeof s.log === 'object') {
      Object.keys(s.log).forEach(function (d) {
        if (!DATE_RE.test(d) || !Array.isArray(s.log[d])) return;
        var entries = s.log[d].filter(function (e) {
          return e && typeof e.name === 'string' && Number.isFinite(Number(e.kcal)) && e.kcal > 0;
        }).map(function (e) {
          return {
            id: String(e.id || uid()),
            meal: ['sang', 'trua', 'toi', 'snack'].indexOf(e.meal) >= 0 ? e.meal : 'snack',
            name: e.name.slice(0, 80),
            kcal: Math.round(Number(e.kcal)),
            qty: Math.max(1, Math.min(50, Math.round(Number(e.qty) || 1))),
            foodId: e.foodId ? String(e.foodId) : null,
            at: Number(e.at) || 0,
          };
        });
        if (entries.length) out.log[d] = entries;
      });
    }

    out.customFoods = Array.isArray(s.customFoods) ? s.customFoods.filter(function (f) {
      return f && typeof f.name === 'string' && Number.isFinite(Number(f.kcal)) && f.kcal > 0;
    }).map(function (f) {
      return { id: String(f.id || 'c-' + uid()), name: f.name.slice(0, 80), kcal: Math.round(Number(f.kcal)), unit: (f.unit || '1 phần').slice(0, 30), cat: 'khac' };
    }) : [];

    out.settings = Object.assign({ theme: 'auto' }, (s.settings && typeof s.settings === 'object') ? s.settings : {});
    if (['auto', 'light', 'dark'].indexOf(out.settings.theme) < 0) out.settings.theme = 'auto';
    return out;
  }
  function clampNum(v, lo, hi) {
    var n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.min(hi, Math.max(lo, n));
  }
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) return normalize(JSON.parse(raw));
    } catch (e) { console.warn('Không đọc được dữ liệu cũ', e); }
    return L.createState();
  }
  // Mọi thay đổi đi qua đây: áp dụng → vẽ lại → LƯU. Vẽ lỗi thì khôi phục state cũ, không lưu.
  function apply(fn, okMsg) {
    var prev = state;
    try {
      state = fn(state);
      render();
      save();
      if (okMsg) toast(okMsg);
    } catch (e) {
      state = prev;
      try { render(); } catch (e2) { /* giữ màn hình cũ */ }
      alert(e.message || String(e));
    }
  }

  // ── Kế hoạch: các số dẫn xuất ─────────────────────────
  // Cân dùng để tính = lần cân gần nhất; chưa cân lần nào thì lấy cân lúc lập kế hoạch
  function currentKg() {
    var w = L.latestWeight(state.weights);
    if (w) return w.kg;
    return state.goal ? state.goal.startWeightKg : null;
  }
  function planNumbers() {
    if (!state.profile || !state.goal) return null;
    var kg = currentKg();
    if (kg == null) return null;
    var b = L.bmr({ sex: state.profile.sex, age: state.profile.age, heightCm: state.profile.heightCm, weightKg: kg });
    var t = L.tdee(b, state.profile.activity);
    var reached = kg <= state.goal.targetWeightKg;
    var budget = reached ? Math.round(t / 10) * 10 : L.dailyBudget(t, state.goal.deficitKgPerWeek);
    return {
      bmr: b, tdee: t, budget: budget, reached: reached,
      status: L.budgetStatus(budget, state.profile.sex),
      eta: L.projectGoalDate(kg, state.goal.targetWeightKg, state.goal.deficitKgPerWeek, L.todayStr()),
    };
  }

  // ── Vẽ: tab Hôm nay ───────────────────────────────────
  var RING_C = 540.35; // 2π × 86
  function renderToday() {
    var today = L.todayStr();
    var isToday = viewDate === today;
    $('#day-label').textContent = isToday ? 'Hôm nay, ' + L.fmtDateVN(viewDate).split(', ')[1] : L.fmtDateVN(viewDate);
    $('#btn-day-next').disabled = isToday;

    var plan = planNumbers();
    var entries = state.log[viewDate] || [];
    var eaten = L.dayTotal(entries);

    $('#today-onboard').classList.toggle('hidden', !!plan);
    $('#today-hero').classList.toggle('hidden', !plan);
    if (plan) {
      var left = plan.budget - eaten;
      var ratio = plan.budget > 0 ? eaten / plan.budget : 0;
      var ring = $('#ring-fill');
      ring.style.strokeDashoffset = String(RING_C * Math.max(0, 1 - Math.min(ratio, 1)));
      ring.classList.toggle('warn', ratio >= 0.85 && ratio <= 1);
      ring.classList.toggle('over', ratio > 1);
      $('#ring-num').textContent = fmtNum(Math.abs(left));
      $('#ring-num').classList.toggle('over', left < 0);
      $('#ring-sub').textContent = left >= 0 ? 'kcal còn lại' : 'kcal VƯỢT ngân sách';
      $('#stat-budget').textContent = fmtNum(plan.budget);
      $('#stat-eaten').textContent = fmtNum(eaten);
      $('#stat-streak').textContent = L.streak(state.log, today) + '🔥';
    }

    // Cân nhanh: chỉ hiện khi đang xem hôm nay và hôm nay chưa cân
    var weighed = L.weightOn(state.weights, today);
    $('#quick-weigh').classList.toggle('hidden', !isToday || !!weighed);

    // 4 card bữa
    var mealsBox = $('#meals');
    mealsBox.textContent = '';
    var totals = L.mealTotals(entries);
    L.MEALS.forEach(function (m) {
      var list = entries.filter(function (e) { return e.meal === m.id; });
      var card = el('div', { class: 'card meal-card' }, [
        el('div', { class: 'meal-head' }, [
          el('span', { class: 'meal-title', text: m.emoji + ' ' + m.label }),
          el('span', { class: 'meal-total mono', text: totals[m.id] ? fmtNum(totals[m.id]) + ' kcal' : '' }),
        ]),
        el('ul', { class: 'meal-entries' }, list.map(function (e) {
          return el('li', null, [
            el('span', { class: 'entry-name', text: e.name }),
            e.qty > 1 ? el('span', { class: 'entry-qty mono', text: '×' + e.qty }) : null,
            el('span', { class: 'entry-kcal mono', text: fmtNum(e.kcal * e.qty) }),
            el('button', { class: 'entry-del', 'aria-label': 'Xoá ' + e.name, text: '✕', onclick: function () {
              apply(function (s) { return removeEntry(s, viewDate, e.id); }, 'Đã xoá ' + e.name);
            } }),
          ]);
        })),
        el('button', { class: 'meal-add', text: '+ Thêm món', onclick: function () { openSheet(m.id); } }),
      ]);
      mealsBox.appendChild(card);
    });
  }
  function removeEntry(s, date, id) {
    var next = JSON.parse(JSON.stringify(s));
    next.log[date] = (next.log[date] || []).filter(function (e) { return e.id !== id; });
    if (!next.log[date].length) delete next.log[date];
    return next;
  }
  // Thêm món: cùng foodId + cùng bữa thì tăng qty thay vì thêm dòng trùng
  function addEntry(s, date, meal, food) {
    var next = JSON.parse(JSON.stringify(s));
    if (!next.log[date]) next.log[date] = [];
    var existing = food.id ? next.log[date].find(function (e) { return e.foodId === food.id && e.meal === meal; }) : null;
    if (existing) existing.qty = Math.min(existing.qty + 1, 50);
    else next.log[date].push({ id: uid(), meal: meal, name: food.name, kcal: food.kcal, qty: 1, foodId: food.id || null, at: Date.now() });
    return next;
  }

  // ── Vẽ: tab Cân nặng ──────────────────────────────────
  function renderWeight() {
    var latest = L.latestWeight(state.weights);
    $('#wn-kg').textContent = latest ? latest.kg.toLocaleString('vi-VN') : '—';

    var vsWeek = $('#wn-vs-week'), vsGoal = $('#wn-vs-goal');
    vsWeek.className = 'badge'; vsGoal.className = 'badge';
    if (latest) {
      var prev = L.weightAtOrBefore(state.weights, L.addDays(latest.date, -7));
      if (prev) {
        var d = Math.round((latest.kg - prev.kg) * 10) / 10;
        vsWeek.textContent = (d > 0 ? '+' : '') + d.toLocaleString('vi-VN') + ' kg';
        vsWeek.classList.add(d < 0 ? 'down' : d > 0 ? 'up' : 'flat');
      } else vsWeek.textContent = '—';
      if (state.goal) {
        var g = Math.round((latest.kg - state.goal.targetWeightKg) * 10) / 10;
        vsGoal.textContent = g <= 0 ? 'Đạt rồi 🎉' : 'còn ' + g.toLocaleString('vi-VN') + ' kg';
        if (g <= 0) vsGoal.classList.add('down');
      } else vsGoal.textContent = '—';
    } else { vsWeek.textContent = '—'; vsGoal.textContent = '—'; }

    renderChart();

    // Lịch sử (mới nhất trước, tối đa 60 dòng)
    var ul = $('#weight-history');
    ul.textContent = '';
    var rows = state.weights.slice().reverse().slice(0, 60);
    $('#weight-history-empty').classList.toggle('hidden', rows.length > 0);
    rows.forEach(function (w) {
      ul.appendChild(el('li', null, [
        el('span', null, [
          el('span', { class: 'mono', text: w.kg.toLocaleString('vi-VN') + ' kg ' }),
          el('span', { class: 'row-sub', text: L.fmtDateVN(w.date) }),
        ]),
        el('span', null, [
          el('button', { class: 'btn sm', text: 'Sửa', onclick: function () {
            var v = prompt('Cân nặng ngày ' + w.date + ' (kg):', String(w.kg));
            if (v == null) return;
            var kg = Number(String(v).replace(',', '.'));
            if (!Number.isFinite(kg) || kg < 20 || kg > 300) { alert('Số cân không hợp lệ'); return; }
            apply(function (s) {
              var n = JSON.parse(JSON.stringify(s));
              n.weights = L.upsertWeight(n.weights, w.date, kg);
              return n;
            }, 'Đã sửa');
          } }),
          el('button', { class: 'entry-del', text: '✕', 'aria-label': 'Xoá lần cân', onclick: function () {
            if (!confirm('Xoá lần cân ' + w.kg + ' kg ngày ' + w.date + '?')) return;
            apply(function (s) {
              var n = JSON.parse(JSON.stringify(s));
              n.weights = L.removeWeight(n.weights, w.date);
              return n;
            }, 'Đã xoá');
          } }),
        ]),
      ]));
    });
  }
  var SVGNS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    var e = document.createElementNS(SVGNS, tag);
    Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }
  function renderChart() {
    var m = L.chartModel(state.weights, {
      rangeDays: chartRange, today: L.todayStr(),
      targetKg: state.goal ? state.goal.targetWeightKg : null,
      width: 360, height: 220, pad: 24,
    });
    $('#chart-empty').classList.toggle('hidden', !!m);
    $('#chart-svg').classList.toggle('hidden', !m);
    if (!m) return;
    $('#chart-area').setAttribute('d', m.areaPath);
    $('#chart-line').setAttribute('d', m.linePath);
    $('#chart-ma').setAttribute('d', m.maPath);
    var goal = $('#chart-goal');
    if (m.goalY != null) {
      goal.setAttribute('x1', 24); goal.setAttribute('x2', 336);
      goal.setAttribute('y1', m.goalY); goal.setAttribute('y2', m.goalY);
      goal.classList.remove('hidden');
    } else goal.classList.add('hidden');

    var grid = $('#chart-grid'); grid.textContent = '';
    var labels = $('#chart-labels'); labels.textContent = '';
    m.yTicks.forEach(function (t) {
      grid.appendChild(svgEl('line', { x1: 24, x2: 336, y1: t.y, y2: t.y }));
      var lb = svgEl('text', { x: 340, y: t.y + 3, class: 'chart-label' });
      lb.textContent = String(t.kg);
      labels.appendChild(lb);
    });
    m.xTicks.forEach(function (t, i) {
      var p = t.date.split('-');
      var lb = svgEl('text', { x: t.x, y: 214, class: 'chart-label', 'text-anchor': i === 0 ? 'start' : i === 2 ? 'end' : 'middle' });
      lb.textContent = +p[2] + '/' + +p[1];
      labels.appendChild(lb);
    });
    if (m.goalY != null && state.goal) {
      var gl = svgEl('text', { x: 26, y: m.goalY - 4, class: 'chart-goal-label' });
      gl.textContent = 'mục tiêu ' + state.goal.targetWeightKg;
      labels.appendChild(gl);
    }
    var dots = $('#chart-dots'); dots.textContent = '';
    // nhiều điểm quá thì chỉ chấm điểm cuối cho đỡ rối
    var showDots = m.dots.length <= 45 ? m.dots : [m.dots[m.dots.length - 1]];
    showDots.forEach(function (d) {
      dots.appendChild(svgEl('circle', { cx: d.x, cy: d.y, r: 2.4, class: 'chart-dot' }));
    });
  }

  // ── Vẽ: tab Kế hoạch ──────────────────────────────────
  function segVal(id) {
    var b = $('#' + id + ' button.active');
    return b ? b.getAttribute('data-val') : null;
  }
  function segSet(id, val) {
    $$('#' + id + ' button').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-val') === String(val));
    });
  }
  function renderPlanForm() {
    if (state.profile) {
      segSet('seg-sex', state.profile.sex);
      $('#f-age').value = state.profile.age;
      $('#f-height').value = state.profile.heightCm;
      $('#f-activity').value = String(state.profile.activity);
    }
    var kg = currentKg();
    if (kg != null && !$('#f-weight').value) $('#f-weight').value = kg;
    if (state.goal) {
      $('#f-target').value = state.goal.targetWeightKg;
      segSet('seg-deficit', state.goal.deficitKgPerWeek);
    }
    renderPlanResults();
  }
  function renderPlanResults() {
    var plan = planNumbers();
    $('#plan-results').classList.toggle('hidden', !plan);
    if (!plan) return;
    $('#r-bmr').textContent = fmtNum(plan.bmr);
    $('#r-tdee').textContent = fmtNum(plan.tdee);
    $('#r-budget').textContent = fmtNum(plan.budget);
    $('#plan-warning').classList.toggle('hidden', plan.status !== 'low');
    $('#r-eta').textContent = plan.reached
      ? 'Đã đạt mục tiêu 🎉 — ngân sách chuyển sang mức duy trì'
      : plan.eta ? L.fmtDateVN(plan.eta) + ' (' + L.daysBetween(L.todayStr(), plan.eta) + ' ngày nữa)' : '—';
  }

  // ── Vẽ: tab Cài đặt ───────────────────────────────────
  function renderSettings() {
    segSet('seg-theme', state.settings.theme);
    var ul = $('#custom-foods');
    ul.textContent = '';
    $('#custom-foods-empty').classList.toggle('hidden', state.customFoods.length > 0);
    state.customFoods.forEach(function (f) {
      ul.appendChild(el('li', null, [
        el('span', null, [
          el('span', { text: f.name + ' ' }),
          el('span', { class: 'row-sub mono', text: f.kcal + ' kcal · ' + f.unit }),
        ]),
        el('button', { class: 'entry-del', text: '✕', 'aria-label': 'Xoá món', onclick: function () {
          if (!confirm('Xoá "' + f.name + '" khỏi món của tôi? (các bữa đã ghi vẫn giữ nguyên)')) return;
          apply(function (s) {
            var n = JSON.parse(JSON.stringify(s));
            n.customFoods = n.customFoods.filter(function (x) { return x.id !== f.id; });
            return n;
          }, 'Đã xoá');
        } }),
      ]));
    });
  }

  // ── Render tổng ───────────────────────────────────────
  var TAB_TITLES = { homnay: 'Hôm nay', cannang: 'Cân nặng', kehoach: 'Kế hoạch', caidat: 'Cài đặt' };
  function render() {
    $('#topbar-title').textContent = TAB_TITLES[activeTab];
    $$('.panel').forEach(function (p) { p.hidden = p.id !== 'tab-' + activeTab; });
    $$('.nav-btn').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === activeTab); });
    if (activeTab === 'homnay') renderToday();
    else if (activeTab === 'cannang') renderWeight();
    else if (activeTab === 'kehoach') renderPlanForm();
    else renderSettings();
  }
  function gotoTab(tab) { activeTab = tab; render(); window.scrollTo(0, 0); }

  // ── Sheet thêm món ────────────────────────────────────
  var sheetCat = '';
  function mealLabel(id) {
    for (var i = 0; i < L.MEALS.length; i++) if (L.MEALS[i].id === id) return L.MEALS[i].label;
    return id;
  }
  function openSheet(meal) {
    sheetMeal = meal;
    $('#sheet-title').textContent = 'Thêm vào ' + mealLabel(meal).toLowerCase();
    $('#food-search').value = '';
    $('#sheet').classList.remove('hidden');
    $('#sheet-backdrop').classList.remove('hidden');
    renderFoodList();
  }
  function closeSheet() {
    $('#sheet').classList.add('hidden');
    $('#sheet-backdrop').classList.add('hidden');
  }
  function allFoods() {
    // món tự tạo đứng trước cho dễ với tới; precompute _norm 1 lần để search nhanh
    return state.customFoods.concat(DB).map(function (f) {
      if (f._norm == null) f._norm = L.stripAccents(f.name);
      return f;
    });
  }
  function renderFoodList() {
    var q = $('#food-search').value;
    var foods = allFoods();
    if (sheetCat) foods = foods.filter(function (f) { return f.cat === sheetCat; });
    var results = L.searchFoods(q, foods).slice(0, 60);
    var ul = $('#food-list');
    ul.textContent = '';
    if (!results.length) {
      ul.appendChild(el('li', { class: 'food-none', text: 'Không thấy món nào — nhập tay bên dưới nhé 👇' }));
      return;
    }
    results.forEach(function (f) {
      ul.appendChild(el('li', {
        onclick: function () {
          apply(function (s) { return addEntry(s, viewDate, sheetMeal, f); }, '+ ' + f.name);
        },
      }, [
        el('span', { class: 'food-name' }, [
          f.name,
          el('span', { class: 'food-unit', text: f.unit }),
        ]),
        el('span', { class: 'food-kcal', text: f.kcal + ' kcal' }),
      ]));
    });
  }

  // ── Theme ─────────────────────────────────────────────
  function applyTheme() {
    var t = state.settings.theme;
    var dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    $('#btn-theme').textContent = dark ? '☀️' : '🌙';
    try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
  }
  function setTheme(t) {
    apply(function (s) {
      var n = JSON.parse(JSON.stringify(s));
      n.settings.theme = t;
      return n;
    });
    applyTheme();
  }

  // ── Gắn sự kiện ───────────────────────────────────────
  $$('.nav-btn').forEach(function (b) {
    b.addEventListener('click', function () { gotoTab(b.getAttribute('data-tab')); });
  });
  $$('[data-goto]').forEach(function (b) {
    b.addEventListener('click', function () { gotoTab(b.getAttribute('data-goto')); });
  });

  // Ngày trước/sau
  $('#btn-day-prev').addEventListener('click', function () { viewDate = L.addDays(viewDate, -1); render(); });
  $('#btn-day-next').addEventListener('click', function () {
    if (viewDate < L.todayStr()) { viewDate = L.addDays(viewDate, 1); render(); }
  });

  // Cân nhanh
  $('#btn-quick-weigh').addEventListener('click', function () {
    var v = Number(String($('#quick-weigh-input').value).replace(',', '.'));
    if (!Number.isFinite(v) || v < 20 || v > 300) { alert('Nhập số cân từ 20–300 kg nhé'); return; }
    apply(function (s) {
      var n = JSON.parse(JSON.stringify(s));
      n.weights = L.upsertWeight(n.weights, L.todayStr(), v);
      return n;
    }, 'Đã ghi ' + v + ' kg');
    $('#quick-weigh-input').value = '';
  });

  // Segmented controls (chỉ đổi giao diện nút; giá trị đọc khi bấm Lưu)
  ['seg-sex', 'seg-deficit'].forEach(function (id) {
    $$('#' + id + ' button').forEach(function (b) {
      b.addEventListener('click', function () { segSet(id, b.getAttribute('data-val')); });
    });
  });
  $$('#seg-theme button').forEach(function (b) {
    b.addEventListener('click', function () { setTheme(b.getAttribute('data-val')); });
  });
  $('#btn-theme').addEventListener('click', function () {
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    setTheme(dark ? 'light' : 'dark');
  });

  // Lưu kế hoạch
  $('#btn-save-plan').addEventListener('click', function () {
    var age = clampNum($('#f-age').value, 10, 100);
    var height = clampNum($('#f-height').value, 100, 230);
    var weight = clampNum(String($('#f-weight').value).replace(',', '.'), 20, 300);
    var target = clampNum(String($('#f-target').value).replace(',', '.'), 20, 300);
    if (age == null || height == null || weight == null || target == null) {
      alert('Điền đủ tuổi, chiều cao, cân hiện tại và cân mục tiêu nhé.');
      return;
    }
    var sex = segVal('seg-sex') || 'male';
    var deficit = Number(segVal('seg-deficit')) || 0.5;
    var activity = Number($('#f-activity').value) || 1.375;
    apply(function (s) {
      var n = JSON.parse(JSON.stringify(s));
      n.profile = { sex: sex, age: age, heightCm: height, activity: activity };
      n.goal = n.goal || {};
      n.goal.targetWeightKg = target;
      n.goal.deficitKgPerWeek = deficit;
      if (n.goal.startWeightKg == null) { n.goal.startWeightKg = weight; n.goal.startDate = L.todayStr(); }
      n.weights = L.upsertWeight(n.weights, L.todayStr(), weight); // cân nhập ở form = lần cân hôm nay
      return n;
    }, 'Đã lưu kế hoạch 💪');
  });

  // Chart range
  $$('#chart-range .pill').forEach(function (b) {
    b.addEventListener('click', function () {
      chartRange = Number(b.getAttribute('data-range'));
      $$('#chart-range .pill').forEach(function (x) { x.classList.toggle('active', x === b); });
      renderChart();
    });
  });

  // Sheet
  $('#sheet-close').addEventListener('click', closeSheet);
  $('#sheet-backdrop').addEventListener('click', closeSheet);
  $('#food-search').addEventListener('input', renderFoodList);
  $$('#food-cats .pill').forEach(function (b) {
    b.addEventListener('click', function () {
      sheetCat = b.getAttribute('data-cat');
      $$('#food-cats .pill').forEach(function (x) { x.classList.toggle('active', x === b); });
      renderFoodList();
    });
  });
  $('#btn-manual-add').addEventListener('click', function () {
    var name = $('#manual-name').value.trim();
    var kcal = clampNum($('#manual-kcal').value, 1, 5000);
    if (!name || kcal == null) { alert('Nhập tên món và số kcal nhé.'); return; }
    var saveIt = $('#manual-save').checked;
    apply(function (s) {
      var n = JSON.parse(JSON.stringify(s));
      var foodId = null;
      if (saveIt) {
        foodId = 'c-' + uid();
        n.customFoods.push({ id: foodId, name: name, kcal: Math.round(kcal), unit: '1 phần', cat: 'khac' });
      }
      return addEntry(n, viewDate, sheetMeal, { id: foodId, name: name, kcal: Math.round(kcal) });
    }, '+ ' + name);
    $('#manual-name').value = '';
    $('#manual-kcal').value = '';
    $('#manual-save').checked = false;
    renderFoodList();
  });

  // Xuất / nhập / xoá dữ liệu
  $('#btn-export').addEventListener('click', function () {
    var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    var a = el('a', { href: URL.createObjectURL(blob), download: 'giam-can-' + L.todayStr() + '.json' });
    document.body.appendChild(a); a.click(); a.remove();
    toast('Đã xuất file backup');
  });
  $('#btn-import').addEventListener('click', function () { $('#import-file').click(); });
  $('#import-file').addEventListener('change', function (ev) {
    var f = ev.target.files[0]; if (!f) return;
    var r = new FileReader();
    r.onload = function () {
      try {
        var imported = normalize(JSON.parse(r.result)); // ném lỗi nếu file hỏng → không đụng state
        var days = Object.keys(imported.log).length;
        if (!confirm('Thay toàn bộ dữ liệu hiện tại bằng file này?\n(' + imported.weights.length + ' lần cân, ' + days + ' ngày có log ăn uống)')) return;
        apply(function () { return imported; }, 'Đã nạp dữ liệu');
        applyTheme();
      } catch (e) { alert(e.message); }
    };
    r.readAsText(f);
    ev.target.value = '';
  });
  $('#btn-wipe').addEventListener('click', function () {
    if (!confirm('Xoá HẾT dữ liệu (kế hoạch, cân nặng, log ăn uống)?')) return;
    if (!confirm('Chắc chắn chứ? Không hoàn tác được đâu. Nên bấm "Xuất dữ liệu" trước.')) return;
    apply(function () { return L.createState(); }, 'Đã xoá sạch');
    applyTheme();
  });

  // Qua ngày mới khi app để mở qua đêm / mở lại từ background:
  // nếu trước đó đang xem "hôm nay" (cũ) thì nhảy sang hôm nay mới; đang xem ngày cũ thì giữ nguyên.
  var lastToday = L.todayStr();
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    var t = L.todayStr();
    if (t !== lastToday) {
      if (viewDate === lastToday) viewDate = t;
      lastToday = t;
    }
    render();
  });

  // ── Khởi động ─────────────────────────────────────────
  state = load();
  applyTheme();
  render();
})();
