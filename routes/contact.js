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
    // Send Email
    let transporter;
    if (process.env.EMAIL_SERVICE === 'gmail'){
      transporter = nodemailer.createTransport({
        service: process.env.EMAIL_SERVICE,
        auth: {
          user: process.env.EMAIL_USER,
          pass: Buffer.from(process.env.EMAIL_PASS, 'base64').toString('utf-8'),
        },
      });
    } else {
      transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST,
        port: process.env.EMAIL_PORT,
        secure: true,
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS,
        },
      });
    }
    
    // console.log(transporter);
    
    // Compose the email
    const mailOptions = {
      from: `"Contact Us Form" <${process.env.EMAIL_USER}>`,
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
