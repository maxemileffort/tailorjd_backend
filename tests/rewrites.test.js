const request = require('supertest');
const { app } = require('./setup');
const { PrismaClient } = require('@prisma/client');

jest.mock('@prisma/client');
jest.mock('../middleware/auth', () => ({
  authenticate: (req, res, next) => {
      req.user = { id: 1, isAdmin: false }; // Mock authenticated admin user
      next();
  },
  isAdmin: (req, res, next) => {
      if (req.user && req.user.isAdmin) {
          next();
      } else {
          res.status(403).json({ error: 'Forbidden' });
      }
  },
}));

const prisma = new PrismaClient();

describe('POST /api/rewrites', () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    test('should create a new document collection and return 201 status', async () => {
        prisma.docCollection.create.mockResolvedValue({ id: 1 });
        prisma.docs.create
            .mockResolvedValueOnce({ id: 2, docType: 'USER_RESUME' })
            .mockResolvedValueOnce({ id: 3, docType: 'JD' })
            .mockResolvedValueOnce({ id: 4, docType: 'ANALYSIS' })
            .mockResolvedValueOnce({ id: 5, docType: 'REWRITE_RESUME' })
            .mockResolvedValueOnce({ id: 6, docType: 'COVER_LETTER' });

        const mockOpenAIResponse = [{ message: { content: 'Mock content' } }];
        global.fetch = jest.fn(() =>
            Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ choices: mockOpenAIResponse }),
            })
        );

        const response = await request(app)
            .post('/api/rewrites')
            .send({
                user_resume: 'Sample resume',
                jd: 'Sample job description',
            })
            .expect(201);

        expect(response.body.collectionId).toBe(1);
        expect(response.body.docs).toHaveLength(5);
    });

    test('should return 400 if user_resume or jd is missing', async () => {
        const response = await request(app)
            .post('/api/rewrites')
            .send({ user_resume: 'Sample resume' })
            .expect(400);

        expect(response.body.error).toBe('User resume and job description are required');
    });

    test('should handle OpenAI API errors gracefully', async () => {
        prisma.docCollection.create.mockResolvedValue({ id: 1 });
        prisma.docs.create
            .mockResolvedValueOnce({ id: 2, docType: 'USER_RESUME' })
            .mockResolvedValueOnce({ id: 3, docType: 'JD' });

        global.fetch = jest.fn(() =>
            Promise.resolve({
                ok: false,
                status: 500,
                statusText: 'Internal Server Error',
            })
        );

        const response = await request(app)
            .post('/api/rewrites')
            .send({
                user_resume: 'Sample resume',
                jd: 'Sample job description',
            })
            .expect(500);

        expect(response.body.error).toBe('An error occurred while processing the request');
    });

    test('should return 500 on unexpected errors', async () => {
        prisma.docCollection.create.mockRejectedValue(new Error('Unexpected error'));

        const response = await request(app)
            .post('/api/rewrites')
            .send({
                user_resume: 'Sample resume',
                jd: 'Sample job description',
            })
            .expect(500);

        expect(response.body.error).toBe('An error occurred while processing the request');
    });
});
