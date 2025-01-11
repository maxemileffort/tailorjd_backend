const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate, isAdmin } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// Get a single article by ID
router.get('/:id', async (req, res) => {
  try {
    const article = await prisma.article.findUnique({
      where: { id: req.params.id },
      include: { author: true }, // Include author information
    });
    if (!article) {
      return res.status(404).json({ error: 'Article not found.' });
    }
    res.status(200).json(article);
  } catch (err) {
    console.error('Error fetching article:', err);
    res.status(500).json({ error: 'Failed to fetch article.' });
  }
});

// Get all articles
// router.get('/', async (req, res) => {
//   try {
//     const articles = await prisma.article.findMany({
//       include: { author: true }, // Include author information
//     });
//     res.status(200).json(articles);
//   } catch (err) {
//     console.error('Error fetching articles:', err);
//     res.status(500).json({ error: 'Failed to fetch articles.' });
//   }
// });

router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const articles = await prisma.article.findMany({
      skip: (page - 1) * limit,
      take: parseInt(limit),
      include: { 
        author: true, 
      },
    });
    res.status(200).json(articles);
  } catch (err) {
    console.error('Error fetching articles:', err);
    res.status(500).json({ error: 'Failed to fetch articles.' });
  }
});

// Create a new article (admin only)
router.post('/', authenticate, isAdmin, async (req, res) => {
  const { title, content, metaTitle, metaDescription, schemaMarkup } = req.body;

  if (!title || !content) {
    return res.status(400).json({ error: 'Title and content are required.' });
  }

  try {
    const newArticle = await prisma.article.create({
      data: {
        title,
        content,
        metaTitle,
        metaDescription,
        schemaMarkup,
        authorId: req.user.id, // Set the authenticated user as the author
      },
    });
    res.status(201).json(newArticle);
  } catch (err) {
    console.error('Error creating article:', err);
    res.status(500).json({ error: 'Failed to create article.' });
  }
});

// Update an article (admin only)
router.put('/:id', authenticate, isAdmin, async (req, res) => {
  const { title, content, metaTitle, metaDescription, schemaMarkup } = req.body;

  try {
    const updatedArticle = await prisma.article.update({
      where: { id: req.params.id },
      data: {
        title,
        content,
        metaTitle,
        metaDescription,
        schemaMarkup,
      },
    });
    res.status(200).json(updatedArticle);
  } catch (err) {
    console.error('Error updating article:', err);
    if (err.code === 'P2025') { // Prisma record not found error
      return res.status(404).json({ error: 'Article not found.' });
    }
    res.status(500).json({ error: 'Failed to update article.' });
  }
});

// Delete an article (admin only)
router.delete('/:id', authenticate, isAdmin, async (req, res) => {
  try {
    await prisma.article.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) {
    console.error('Error deleting article:', err);
    if (err.code === 'P2025') { // Prisma record not found error
      return res.status(404).json({ error: 'Article not found.' });
    }
    res.status(500).json({ error: 'Failed to delete article.' });
  }
});

module.exports = router;
