import { config, areaCoords } from '../config.js';
import { query } from '../db.js';
import { categoryLabel } from '../i18n.js';

/** Everything the dashboard needs in one round-trip. */
export async function overview() {
  const since24 = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  const [totals] = await query(
    `SELECT COUNT(*)::int AS reports,
            COUNT(*) FILTER (WHERE status IN ('resolved','confirmed'))::int AS resolved,
            COUNT(*) FILTER (WHERE status = 'confirmed')::int AS confirmed,
            COUNT(*) FILTER (WHERE status = 'disputed')::int AS disputed,
            COUNT(*) FILTER (WHERE created_at >= $1::timestamptz)::int AS last24h,
            COUNT(DISTINCT phone)::int AS customers
     FROM tickets`,
    [since24],
  );
  const [inc] = await query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status IN ('possible','investigating'))::int AS active,
            COUNT(DISTINCT area) FILTER (WHERE status IN ('possible','investigating'))::int AS areas_affected
     FROM incidents`,
  );
  const [rw] = await query(
    `SELECT COUNT(*) FILTER (WHERE status IN ('sent','simulated'))::int AS count,
            COALESCE(SUM(amount) FILTER (WHERE status IN ('sent','simulated')), 0)::float AS total
     FROM rewards`,
  );
  const [ms] = await query(`SELECT COUNT(*) FILTER (WHERE direction = 'out')::int AS sms_out FROM messages`);

  const incidents = await query(
    `SELECT * FROM incidents ORDER BY (status = 'resolved'), report_count DESC, id DESC LIMIT 50`,
  );
  const reports = await query(`SELECT * FROM tickets ORDER BY id DESC LIMIT 60`);
  const messages = await query(`SELECT * FROM messages ORDER BY id DESC LIMIT 40`);
  const rewards = await query(`SELECT * FROM rewards ORDER BY id DESC LIMIT 20`);

  const byCategory = await query(`SELECT category, COUNT(*)::int AS n FROM tickets GROUP BY category ORDER BY n DESC`);
  const byArea = await query(`SELECT area, COUNT(*)::int AS n FROM tickets GROUP BY area ORDER BY n DESC`);

  const recent = await query(`SELECT created_at FROM tickets WHERE created_at >= $1::timestamptz`, [since24]);
  const buckets = Array.from({ length: 24 }, (_, i) => {
    const start = new Date(Math.floor(Date.now() / 3600000) * 3600000 - (23 - i) * 3600000);
    return { hour: start.toISOString(), n: 0 };
  });
  for (const r of recent) {
    const idx = 23 - (Math.floor(Date.now() / 3600000) - Math.floor(new Date(r.created_at).getTime() / 3600000));
    if (idx >= 0 && idx < 24) buckets[idx].n++;
  }

  // Map: one point per area, coloured by its worst active incident.
  const mapPoints = config.areas.map((area) => {
    const active = incidents.filter((i) => i.area === area && i.status !== 'resolved');
    const [lat, lng] = areaCoords(area);
    const openReports = reports.filter((r) => r.area === area && ['open', 'linked'].includes(r.status)).length;
    const worst = active.sort((a, b) => b.report_count - a.report_count)[0];
    return {
      area, lat, lng,
      reports: byArea.find((a) => a.area === area)?.n || 0,
      openReports,
      severity: worst ? (worst.confidence === 'LOW' ? 'amber' : 'red') : openReports ? 'amber' : 'green',
      incident: worst ? { id: worst.id, code: worst.code, category: worst.category, reports: worst.report_count } : null,
    };
  });

  return {
    stats: {
      reports: totals.reports,
      customers: totals.customers,
      last24h: totals.last24h,
      resolvedPct: totals.reports ? Math.round((totals.resolved / totals.reports) * 100) : 0,
      confirmed: totals.confirmed,
      disputed: totals.disputed,
      incidentsTotal: inc.total,
      incidentsActive: inc.active,
      areasAffected: inc.areas_affected,
      rewardsCount: rw.count,
      rewardsTotal: rw.total,
      smsSent: ms.sms_out,
    },
    incidents,
    reports,
    messages,
    rewards,
    charts: {
      byCategory: byCategory.map((c) => ({ ...c, label: categoryLabel(c.category, 'en') })),
      byArea,
      hourly: buckets,
    },
    map: mapPoints,
  };
}
