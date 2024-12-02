const request = require('supertest');
const { PrismaClient } = require('@prisma/client');
const { app } = require('./setup'); // Assuming you have a test setup with the app
const jwt = require('jsonwebtoken');

const prisma = new PrismaClient();

let adminToken;
let userToken;
let adminUser;
let regularUser;

beforeAll(async () => {
  // Create mock admin and regular users
  adminUser = await prisma.user.create({
    data: {
      email: 'admin@jest_test.com',
      passwordHash: 'hashed_password',
      isAdmin: true,
    },
  });

  regularUser = await prisma.user.create({
    data: {
      email: 'user@jest_test.com',
      passwordHash: 'hashed_password',
      isAdmin: false,
    },
  });

  // Generate mock JWTs
  adminToken = jwt.sign({ id: adminUser.id, isAdmin: true }, process.env.JWT_SECRET);
  userToken = jwt.sign({ id: regularUser.id, isAdmin: false }, process.env.JWT_SECRET);
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: '@jest_test.com' } } });
  await prisma.$disconnect();
});

describe('Credits API', () => {
  describe('POST /admin/add-credits', () => {
    it('should add credits for a user when requested by an admin', async () => {
      const response = await request(app)
        .post('/api/credits/admin/add-credits')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ userId: regularUser.id, amount: 50 });

      expect(response.statusCode).toBe(200);
      expect(response.body.user.creditBalance).toBe(50);
    });

    it('should return 403 if a non-admin user tries to add credits', async () => {
      const response = await request(app)
        .post('/api/credits/admin/add-credits')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ userId: regularUser.id, amount: 50 });

      expect(response.statusCode).toBe(403);
    });

    it('should return 400 if required fields are missing', async () => {
      const response = await request(app)
        .post('/api/credits/admin/add-credits')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ userId: regularUser.id });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /buy-credits', () => {
    it('should allow a user to buy credits', async () => {
      const response = await request(app)
        .post('/api/credits/buy-credits')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ userId: regularUser.id, amount: 100 });

      expect(response.statusCode).toBe(200);
      expect(response.body.user.creditBalance).toBe(150);
    });

    it('should return 400 if required fields are missing', async () => {
      const response = await request(app)
        .post('/api/credits/buy-credits')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ userId: regularUser.id });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /use-credits', () => {
    it('should allow a user to use credits if they have enough balance', async () => {
      const response = await request(app)
        .post('/api/credits/use-credits')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ userId: regularUser.id, amount: 50 });

      expect(response.statusCode).toBe(200);
      expect(response.body.user.creditBalance).toBe(100); // Assuming they had 150 before
    });

    it('should return 400 if the user has insufficient credits', async () => {
      const response = await request(app)
        .post('/api/credits/use-credits')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ userId: regularUser.id, amount: 1000 });

      expect(response.statusCode).toBe(400);
      expect(response.body.message).toBe('Insufficient credits');
    });

    it('should return 400 if required fields are missing', async () => {
      const response = await request(app)
        .post('/api/credits/use-credits')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ userId: regularUser.id });

      expect(response.statusCode).toBe(400);
    });
  });
});
