/* can-logic.js — TOÀN BỘ tính toán của app Giảm Cân.
   Thuần logic: KHÔNG đụng DOM, KHÔNG đụng localStorage → test được bằng `node --test`.
   Mọi hàm nhận input trả output, không sửa input (trả mảng/object MỚI). */
(function (root) {
  'use strict';

  var SCHEMA_VERSION = 1;
  var KCAL_PER_KG = 7700; // 1 kg mỡ ≈ 7700 kcal
  var MEALS = [
    { id: 'sang', label: 'Bữa sáng', emoji: '🌅' },
    { id: 'trua', label: 'Bữa trưa', emoji: '☀️' },
    { id: 'toi', label: 'Bữa tối', emoji: '🌙' },
    { id: 'snack', label: 'Ăn vặt', emoji: '🍿' },
  ];
  var ACTIVITY_LEVELS = [1.2, 1.375, 1.55, 1.725, 1.9];
  // Sàn calo an toàn phổ biến (NIH/NHS): dưới mức này phải có bác sĩ theo dõi
  var SAFE_FLOOR = { male: 1500, female: 1200 };

  // ── Tính toán năng lượng ─────────────────────────────
  // Mifflin-St Jeor: chính xác hơn Harris-Benedict cho người hiện đại
  function bmr(p) {
    var base = 10 * p.weightKg + 6.25 * p.heightCm - 5 * p.age;
    return Math.round(base + (p.sex === 'male' ? 5 : -161));
  }
  function tdee(bmrKcal, activityFactor) {
    return Math.round(bmrKcal * activityFactor);
  }
  // Ngân sách/ngày = TDEE trừ đi mức thâm hụt tương ứng tốc độ giảm; làm tròn chục cho dễ nhớ
  function dailyBudget(tdeeKcal, deficitKgPerWeek) {
    var deficitPerDay = (deficitKgPerWeek * KCAL_PER_KG) / 7;
    return Math.round((tdeeKcal - deficitPerDay) / 10) * 10;
  }
  function budgetStatus(budget, sex) {
    return budget < SAFE_FLOOR[sex === 'male' ? 'male' : 'female'] ? 'low' : 'ok';
  }
  // Ngày dự kiến đạt mục tiêu; null nếu đã đạt hoặc không thể tính
  function projectGoalDate(currentKg, targetKg, deficitKgPerWeek, fromDate) {
    if (!(deficitKgPerWeek > 0)) return null;
    var toLose = currentKg - targetKg;
    if (toLose <= 0) return null; // đã đạt (hoặc mục tiêu cao hơn cân hiện tại)
    var days = Math.ceil((toLose / deficitKgPerWeek) * 7);
    return addDays(fromDate, days);
  }

  // ── Ngày tháng (mọi ngày là chuỗi 'YYYY-MM-DD' theo giờ LOCAL) ──
  // KHÔNG dùng toISOString(): nó theo UTC, buổi tối ở VN sẽ bị đẩy sang ngày hôm sau.
  function todayStr(now) {
    var d = now || new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }
  function parseDate(str) {
    var p = str.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]); // local midnight
  }
  function addDays(dateStr, n) {
    var d = parseDate(dateStr);
    d.setDate(d.getDate() + n);
    return todayStr(d);
  }
  function daysBetween(a, b) {
    return Math.round((parseDate(b) - parseDate(a)) / 86400000);
  }
  function fmtDateVN(dateStr) {
    var d = parseDate(dateStr);
    var days = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];
    var p = dateStr.split('-');
    return days[d.getDay()] + ', ' + +p[2] + '/' + +p[1] + '/' + p[0];
  }

  // ── Cân nặng ─────────────────────────────────────────
  // 1 điểm mỗi ngày, cân lại trong ngày thì ghi đè (last-wins); trả mảng MỚI đã sort theo ngày
  function upsertWeight(weights, date, kg) {
    var out = weights.filter(function (w) { return w.date !== date; });
    out.push({ date: date, kg: Math.round(kg * 10) / 10 });
    out.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    return out;
  }
  function removeWeight(weights, date) {
    return weights.filter(function (w) { return w.date !== date; });
  }
  function latestWeight(weights) {
    return weights.length ? weights[weights.length - 1] : null;
  }
  function weightOn(weights, date) {
    for (var i = 0; i < weights.length; i++) if (weights[i].date === date) return weights[i];
    return null;
  }
  // Trung bình trượt: với mỗi điểm, avg mọi điểm trong cửa sổ `windowDays` ngày trước đó (tính cả nó)
  function movingAverage(weights, windowDays) {
    var win = windowDays || 7;
    return weights.map(function (w, i) {
      var sum = 0, n = 0;
      for (var j = i; j >= 0; j--) {
        if (daysBetween(weights[j].date, w.date) >= win) break;
        sum += weights[j].kg; n++;
      }
      return { date: w.date, kg: Math.round((sum / n) * 100) / 100 };
    });
  }
  // Cân gần nhất TRƯỚC HOẶC BẰNG mốc `date` (để tính "so với tuần trước")
  function weightAtOrBefore(weights, date) {
    var best = null;
    for (var i = 0; i < weights.length; i++) {
      if (weights[i].date <= date) best = weights[i];
      else break;
    }
    return best;
  }

  // ── Calo ─────────────────────────────────────────────
  function dayTotal(entries) {
    return (entries || []).reduce(function (s, e) { return s + e.kcal * (e.qty || 1); }, 0);
  }
  function mealTotals(entries) {
    var out = { sang: 0, trua: 0, toi: 0, snack: 0 };
    (entries || []).forEach(function (e) {
      if (out[e.meal] != null) out[e.meal] += e.kcal * (e.qty || 1);
    });
    return out;
  }
  // Chuỗi ngày liên tiếp có log calo, tính lùi từ hôm nay (hôm nay chưa log thì tính từ hôm qua)
  function streak(log, today) {
    var d = today;
    if (!(log[d] && log[d].length)) d = addDays(d, -1);
    var n = 0;
    while (log[d] && log[d].length) { n++; d = addDays(d, -1); }
    return n;
  }

  // ── Tìm món (bỏ dấu tiếng Việt) ──────────────────────
  function stripAccents(s) {
    return s.normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/đ/g, 'd').replace(/Đ/g, 'D')
      .toLowerCase().trim();
  }
  // Xếp hạng: khớp đầu chuỗi > khớp đầu từ > khớp giữa chuỗi
  function searchFoods(query, foods) {
    var q = stripAccents(query || '');
    if (!q) return foods.slice();
    var ranked = [];
    foods.forEach(function (f) {
      var name = f._norm != null ? f._norm : stripAccents(f.name);
      var idx = name.indexOf(q);
      if (idx < 0) return;
      var rank = idx === 0 ? 0 : (name[idx - 1] === ' ' ? 1 : 2);
      ranked.push({ f: f, rank: rank, idx: idx });
    });
    ranked.sort(function (a, b) { return a.rank - b.rank || a.idx - b.idx; });
    return ranked.map(function (r) { return r.f; });
  }

  // ── Chart geometry (thuần số — app.js chỉ gán vào SVG) ──
  // → null nếu <2 điểm trong khoảng nhìn. rangeDays=0 nghĩa là "tất cả".
  function chartModel(weights, opt) {
    var W = opt.width, H = opt.height, pad = opt.pad;
    var visible = weights;
    if (opt.rangeDays > 0) {
      var cutoff = addDays(opt.today, -opt.rangeDays);
      visible = weights.filter(function (w) { return w.date >= cutoff; });
    }
    if (visible.length < 2) return null;

    var ma = movingAverage(weights, 7).filter(function (m) {
      return m.date >= visible[0].date;
    });

    var kgs = visible.map(function (w) { return w.kg; });
    var lo = Math.min.apply(null, kgs), hi = Math.max.apply(null, kgs);
    if (opt.targetKg != null) { lo = Math.min(lo, opt.targetKg); hi = Math.max(hi, opt.targetKg); }
    lo = Math.floor((lo - 0.5) * 2) / 2; // đệm ±0.5, chốt bậc 0.5 cho nhãn trục đẹp
    hi = Math.ceil((hi + 0.5) * 2) / 2;
    if (hi - lo < 1) hi = lo + 1;

    var d0 = visible[0].date, d1 = visible[visible.length - 1].date;
    var span = Math.max(daysBetween(d0, d1), 1);
    var plotW = W - pad * 2, plotH = H - pad * 2;
    function x(date) { return pad + (daysBetween(d0, date) / span) * plotW; }
    function y(kg) { return pad + (1 - (kg - lo) / (hi - lo)) * plotH; }
    function pathOf(pts) {
      return pts.map(function (p, i) {
        return (i ? 'L' : 'M') + x(p.date).toFixed(1) + ',' + y(p.kg).toFixed(1);
      }).join(' ');
    }

    var linePath = pathOf(visible);
    var last = visible[visible.length - 1];
    var areaPath = linePath +
      ' L' + x(last.date).toFixed(1) + ',' + (H - pad).toFixed(1) +
      ' L' + x(d0).toFixed(1) + ',' + (H - pad).toFixed(1) + ' Z';

    // 4 vạch ngang chia đều trục y
    var yTicks = [];
    for (var i = 0; i <= 3; i++) {
      var kg = lo + ((hi - lo) * i) / 3;
      yTicks.push({ kg: Math.round(kg * 10) / 10, y: Math.round(y(kg) * 10) / 10 });
    }
    // nhãn trục x: điểm đầu / giữa / cuối
    var mid = visible[Math.floor(visible.length / 2)];
    var xTicks = [
      { date: d0, x: x(d0) },
      { date: mid.date, x: x(mid.date) },
      { date: d1, x: x(d1) },
    ];

    return {
      linePath: linePath,
      areaPath: areaPath,
      maPath: pathOf(ma),
      goalY: opt.targetKg != null ? Math.round(y(opt.targetKg) * 10) / 10 : null,
      dots: visible.map(function (w) {
        return { x: Math.round(x(w.date) * 10) / 10, y: Math.round(y(w.kg) * 10) / 10, date: w.date, kg: w.kg };
      }),
      yTicks: yTicks,
      xTicks: xTicks,
      min: lo, max: hi,
    };
  }

  // ── State mặc định ───────────────────────────────────
  function createState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      profile: null,      // {sex, age, heightCm, activity}
      goal: null,         // {targetWeightKg, deficitKgPerWeek, startWeightKg, startDate}
      weights: [],        // [{date, kg}] sorted, 1 điểm/ngày
      log: {},            // {'YYYY-MM-DD': [{id, meal, name, kcal, qty, foodId, at}]}
      customFoods: [],    // [{id, name, kcal, unit, cat}]
      settings: { theme: 'auto' },
    };
  }

  var api = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    KCAL_PER_KG: KCAL_PER_KG,
    MEALS: MEALS,
    ACTIVITY_LEVELS: ACTIVITY_LEVELS,
    SAFE_FLOOR: SAFE_FLOOR,
    bmr: bmr, tdee: tdee, dailyBudget: dailyBudget, budgetStatus: budgetStatus,
    projectGoalDate: projectGoalDate,
    todayStr: todayStr, addDays: addDays, daysBetween: daysBetween, fmtDateVN: fmtDateVN,
    upsertWeight: upsertWeight, removeWeight: removeWeight, latestWeight: latestWeight,
    weightOn: weightOn, weightAtOrBefore: weightAtOrBefore, movingAverage: movingAverage,
    dayTotal: dayTotal, mealTotals: mealTotals, streak: streak,
    stripAccents: stripAccents, searchFoods: searchFoods,
    chartModel: chartModel,
    createState: createState,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CanLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
