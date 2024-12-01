const request = require('supertest');
const { app, prisma } = require('./setup');
const bcrypt = require('bcrypt');

let token;

beforeAll(async () => {
  // Create an admin user for testing
  const hashedPassword = await bcrypt.hash('hashed_password', 10);
  const admin = await prisma.user.create({
    data: {
      email: 'admin@jest_test_example.com',
      passwordHash: hashedPassword, // Save the hashed password
      isAdmin: true,
    },
  });

  // Login as the admin to get a token
  const response = await request(app)
    .post('/api/auth/login')
    .send({ email: admin.email, password: 'hashed_password' }); // Send plain password for login

  token = response.body.token;
});

afterAll(async () => {
  // Delete all test users
  await prisma.user.deleteMany({
    where: {
      email: {
        contains: '@jest_test_example.com',
      },
    },
  });

  await prisma.$disconnect(); // Close the database connection
});

describe('User API Endpoints', () => {
  it('should create a new user', async () => {
    const response = await request(app)
      .post('/api/users')
      .send({ email: 'test@jest_test_example.com', password: 'test_password' }); // Send plain password

    expect(response.statusCode).toBe(201);
    expect(response.body.email).toBe('test@jest_test_example.com');
  });

  it('should fetch all users (admin only)', async () => {
    const response = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${token}`);

    expect(response.statusCode).toBe(200);
    expect(response.body).toBeInstanceOf(Array);
  });

  it('should fetch a single user by ID', async () => {
    const hashedPassword = await bcrypt.hash('password', 10);
    const user = await prisma.user.create({
      data: { email: 'singleuser@jest_test_example.com', passwordHash: hashedPassword },
    });

    const response = await request(app)
      .get(`/api/users/${user.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(response.statusCode).toBe(200);
    expect(response.body.email).toBe('singleuser@jest_test_example.com');
  });

  it('should update a user', async () => {
    const hashedPassword = await bcrypt.hash('password', 10);
    const user = await prisma.user.create({
      data: { email: 'updateuser@jest_test_example.com', passwordHash: hashedPassword },
    });

    const response = await request(app)
      .put(`/api/users/${user.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'updated@jest_test_example.com', isSubscribed: true });

    expect(response.statusCode).toBe(200);
    expect(response.body.email).toBe('updated@jest_test_example.com');
    expect(response.body.isSubscribed).toBe(true);
  });

  it('should delete a user (admin only)', async () => {
    const hashedPassword = await bcrypt.hash('password', 10);
    const user = await prisma.user.create({
      data: { email: 'deleteuser@jest_test_example.com', passwordHash: hashedPassword },
    });

    const response = await request(app)
      .delete(`/api/users/${user.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(response.statusCode).toBe(204);

    const deletedUser = await prisma.user.findUnique({ where: { id: user.id } });
    expect(deletedUser).toBeNull();
  });
});
