const express = require('express');
const nodemailer = require('nodemailer');
const router = express.Router();

router.post('/', async (req, res) => {
  const { name, email, subject, message } = req.body;

//   console.log(req.body);

  if (!name || !email || !subject || !message) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  try {
    // Configure the email transporter
    const transporter = nodemailer.createTransport({
      service: process.env.EMAIL_SERVICE,
      auth: {
        user: process.env.EMAIL_USER, // Your email
        pass: process.env.EMAIL_PASS, // Your email password or app password
      },
    });

    // console.log(transporter);

    // Compose the email
    const mailOptions = {
      from: `"Contact Us Form" <${email}>`,
      to: process.env.EMAIL_USER, // Your support email
      subject: `New Contact Us Message: ${subject}`,
      text: `From: ${name}\nEmail: ${email}\n\nMessage:\n${message}`,
    };
    // console.log(mailOptions);

    // Send the email
    await transporter.sendMail(mailOptions);

    res.status(200).json({ message: 'Message sent successfully.' });
  } catch (error) {
    console.error('Error sending email:', error);
    res.status(500).json({ error: 'Failed to send message. Please try again later.' });
  }
});

module.exports = router;
