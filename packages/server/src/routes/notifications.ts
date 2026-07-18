import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/middleware.js';

export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);

// GET /notifications?unread
notificationsRouter.get('/', async (req, res, next) => {
  try {
    const unreadOnly = req.query.unread !== undefined;
    const notifications = await prisma.notification.findMany({
      where: {
        userId: req.user!.id,
        ...(unreadOnly && { read: false }),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return res.json({ notifications });
  } catch (err) {
    next(err);
  }
});

// POST /notifications/:id/read
notificationsRouter.post('/:id/read', async (req, res, next) => {
  try {
    const notification = await prisma.notification.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
    });
    if (!notification) return res.status(404).json({ error: 'not found' });

    await prisma.notification.update({ where: { id: notification.id }, data: { read: true } });
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /notifications/read-all
notificationsRouter.post('/read-all', async (req, res, next) => {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.user!.id, read: false },
      data: { read: true },
    });
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
