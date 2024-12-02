const request = require('supertest');
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const rewritesRouter = require('../routes/rewrites');

jest.mock('node-fetch', () => jest.fn());
const fetch = require('node-fetch');

jest.mock('@prisma/client', () => {
  return {
    PrismaClient: jest.fn().mockImplementation(() => ({
      docCollection: {
        create: jest.fn().mockResolvedValue({ id: 'mock-collection-id' }),
      },
      docs: {
        create: jest.fn().mockResolvedValue({ id: 'mock-doc-id' }),
      },
    })),
  };
});

// Mock authenticate middleware
jest.mock('../middleware/auth', () => ({
  authenticate: (req, res, next) => {
    req.user = { id: 'mock-user-id' }; // Mocked user
    next();
  },
}));

describe('Rewrites Router', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();

    app = express();
    app.use(express.json());
    app.use('/rewrites', rewritesRouter);

    // Set mock environment variables
    process.env.OPENAI_API_KEY = 'mock-api-key';
    process.env.SYSTEM_PROMPT = 'Mock system prompt';
    process.env.ANALYSIS_PROMPT = 'Mock analysis prompt';
    process.env.COMPARE_PROMPT = 'Mock compare prompt';
    process.env.COVERLETTER_PROMPT = 'Mock cover letter prompt';
  });

  const validPayload = {
    user_resume: 'Mock user resume content',
    jd: 'Mock job description content',
  };

  it('should successfully create a document collection and associated docs', async () => {
    fetch.mockImplementation((url, options) => {
      const body = JSON.parse(options.body);
      if (body.messages.some((msg) => msg.content.includes('analysis'))) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ choices: [{ message: { content: 'Mock analysis response' } }] }),
        });
      }
      if (body.messages.some((msg) => msg.content.includes('compare'))) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ choices: [{ message: { content: 'Mock rewrite response' } }] }),
        });
      }
      if (body.messages.some((msg) => msg.content.includes('cover letter'))) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ choices: [{ message: { content: 'Mock cover letter response' } }] }),
        });
      }
      return Promise.reject(new Error('Unexpected prompt'));
    });

    const response = await request(app).post('/rewrites').send(validPayload);

    expect(response.statusCode).toBe(201);
    expect(response.body.collectionId).toBeDefined();
    expect(response.body.docs).toHaveLength(5);

    const docs = response.body.docs;
    expect(docs.find((doc) => doc.docType === 'USER_RESUME')).toBeDefined();
    expect(docs.find((doc) => doc.docType === 'JD')).toBeDefined();
    expect(docs.find((doc) => doc.docType === 'ANALYSIS')).toBeDefined();
    expect(docs.find((doc) => doc.docType === 'REWRITE_RESUME')).toBeDefined();
    expect(docs.find((doc) => doc.docType === 'COVER_LETTER')).toBeDefined();
  });

  it('should return 400 if resume or job description is missing', async () => {
    const response = await request(app).post('/rewrites').send({ user_resume: 'Mock resume' });

    expect(response.statusCode).toBe(400);
    expect(response.body.error).toBe('User resume and job description are required');
  });

  it('should handle internal server errors', async () => {
    fetch.mockImplementation(() =>
      Promise.reject(new Error('Mocked API failure'))
    );

    const response = await request(app).post('/rewrites').send(validPayload);

    expect(response.statusCode).toBe(500);
    expect(response.body.error).toBe('An error occurred while processing the request');
  });
});
