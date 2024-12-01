const express = require('express');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const { authenticate, isAdmin } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// Get all users (admin only)
router.get('/', authenticate, isAdmin, async (req, res) => {
  try {
    const users = await prisma.user.findMany();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get a single user by ID
router.get('/:id', authenticate, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// Create a new user
router.post('/', async (req, res) => {
  const { email, password } = req.body; // Expect plain password, not hashed

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    // Hash the password with a salt factor of 10
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const newUser = await prisma.user.create({
      data: { email, passwordHash: hashedPassword }, // Store hashed password
    });

    res.status(201).json(newUser);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Update a user
router.put('/:id', authenticate, async (req, res) => {
  const { email, passwordHash, isSubscribed, isAdmin } = req.body;

  try {
    const updatedUser = await prisma.user.update({
      where: { id: req.params.id },
      data: { email, passwordHash, isSubscribed, isAdmin },
    });
    res.json(updatedUser);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Delete a user (admin only)
router.delete('/:id', authenticate, isAdmin, async (req, res) => {
  try {
    await prisma.user.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

module.exports = router;
