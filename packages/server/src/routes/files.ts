import { Router } from 'express';
import multer from 'multer';
import { prisma } from '../lib/prisma.js';
import { storage } from '../lib/storage.js';
import { extractFileText } from '../lib/extract.js';
import { requireAuth } from '../auth/middleware.js';
import { requireServerMember } from '../auth/guards.js';

export const filesRouter = Router({ mergeParams: true });
export const filesRawRouter = Router();

filesRouter.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// POST /servers/:serverId/files
filesRouter.post(
  '/files',
  requireServerMember(),
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'file required' });

      const ext = req.file.originalname.split('.').pop() ?? '';
      const storageKey = await storage.put(req.file.buffer, {
        ext,
        contentType: req.file.mimetype,
      });

      // Extract readable text (PDF / Office / plain text) so agents can read it.
      const extractedText = await extractFileText(req.file.buffer, req.file.mimetype, req.file.originalname);

      const file = await prisma.fileAsset.create({
        data: {
          serverId: req.params.serverId,
          name: req.file.originalname,
          mimeType: req.file.mimetype,
          size: req.file.size,
          storageKey,
          extractedText,
          uploadedBy: req.user!.id,
        },
      });

      return res.status(201).json({
        file: {
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          size: file.size,
          url: storage.url(file.storageKey),
          createdAt: file.createdAt,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// GET /servers/:serverId/outputs?taskId?
filesRouter.get('/outputs', requireServerMember(), async (req, res, next) => {
  try {
    const taskId = req.query.taskId as string | undefined;
    const outputs = await prisma.output.findMany({
      where: {
        serverId: req.params.serverId,
        ...(taskId && { taskId }),
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({
      outputs: outputs.map((o) => ({
        id: o.id,
        name: o.name,
        mimeType: o.mimeType,
        size: o.size,
        url: storage.url(o.storageKey),
        taskId: o.taskId,
        createdAt: o.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /files/raw/:key — binary passthrough (no auth check — keys are opaque tokens)
filesRawRouter.get('/:key', async (req, res, next) => {
  try {
    const buf = await storage.get(req.params.key);
    // Serve the real content type so images render inline (fallback to octet-stream).
    const asset = await prisma.fileAsset.findFirst({
      where: { storageKey: req.params.key },
      select: { mimeType: true, name: true },
    });
    res.setHeader('Content-Type', asset?.mimeType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    if (asset?.name) res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(asset.name)}"`);
    return res.send(buf);
  } catch (err) {
    next(err);
  }
});
