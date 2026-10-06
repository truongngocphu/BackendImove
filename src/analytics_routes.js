const express = require('express');
const { createAdminGuard } = require('./admin_guard');

function createAnalyticsAdminRouter({ getDb, getAnalytics }) {
  const r = express.Router();
  const { requireAdmin, permit } = createAdminGuard({ getDb });

  r.use(requireAdmin);

  r.get('/', permit('reports.view'), async (req, res) => {
    try {
      const forceRefresh = String(req.query.refresh || '') === '1';
      const payload = await getAnalytics().report(req.query.days, { forceRefresh });
      return res.json(payload);
    } catch (error) {
      console.error('[Analytics] report failed:', error);
      return res.status(500).json({
        code: 'ANALYTICS_FAILED',
        message: error?.message || 'Không thể tải báo cáo Analytics.',
      });
    }
  });

  return r;
}

module.exports = { createAnalyticsAdminRouter };
