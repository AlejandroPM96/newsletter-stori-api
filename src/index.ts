import express, { Request, Response } from 'express';
import nodemailer from 'nodemailer';
import admin from 'firebase-admin';
import path from 'path';
import fs from 'fs';
import { promisify } from 'util';
import dotenv from 'dotenv';

dotenv.config();

// Initialize Firebase
const serviceAccount = require('../serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: 'gs://stori-newsletter-d40ca.appspot.com'  // Your Firebase Storage bucket URL
});

const bucket = admin.storage().bucket();
const firestore = admin.firestore();

const app = express();
const port = 3000;

// Middleware to parse JSON bodies
app.use(express.json());


const unlinkAsync = promisify(fs.unlink);
async function cleanUploadsDir(directory: string) {
  const files = await promisify(fs.readdir)(directory);
  const unlinkPromises = files.map(filename => unlinkAsync(path.join(directory, filename)));
  await Promise.all(unlinkPromises);
}

// Function to get newsletters object from Firestore
async function getNewslettersByName(name: string) {
    try {
      const querySnapshot = await firestore.collection('newsletters').where('name', '==', name).get();
      const newsletters: any[] = [];
  
      querySnapshot.forEach(doc => {
        newsletters.push({
          id: doc.id,
          ...doc.data()
        });
      });
  
      return newsletters;
    } catch (error) {
      console.error('Error fetching newsletters:', error);
      throw error;
    }
  }

// Email sending function
async function sendEmail(to: string, subject: string, text: string, html: string, attachmentPath: string) {
  const transporter = nodemailer.createTransport({
    service: 'Gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to,
    subject,
    text,
    html,
    attachments: [
      {
        filename: path.basename(attachmentPath),
        path: attachmentPath
      }
    ]
  };

  await transporter.sendMail(mailOptions);
}

// Route to handle email sending
app.post('/send-newsletter', async (req: Request, res: Response) => {
    const { name } = req.body;
    const newsletters = await getNewslettersByName(name);
    if (newsletters.length == 0) {
        res.status(200).send('Error no newsletter found with name.' + name);
    }
    const newsletter = newsletters[0]
    console.log('Newsletters:', newsletter);
    const emails = newsletter.recipientList
    const attachmentPath = newsletter.attachmentPath
    if (!emails || !Array.isArray(emails) || emails.length === 0) {
        return res.status(400).send('Emails are required and should be an array.');
    }
    
    if (!attachmentPath) {
        return res.status(400).send('Attachment path is required.');
    }
    const subject = newsletter.subject
    const text = newsletter.text
    const html = "<p>This is an <strong>HTML</strong> version of the newsletter. <a href=\"{{unsubscribeUrl}}\">Unsubscribe</a></p>"
    try {
        // Download file from Firebase Storage
        const file = bucket.file(attachmentPath);
        const destination = path.join(__dirname, 'uploads', path.basename(attachmentPath));
        await file.download({ destination });

        for (const email of emails) {
        await sendEmail(
            email,
            subject,
            text,
            html.replace('{{unsubscribeUrl}}', `http://example.com/unsubscribe?email=${encodeURIComponent(email)}`),
            destination
        );
        }
        await cleanUploadsDir(path.join(__dirname, 'uploads'));
        res.status(200).send('Newsletter sent successfully!');
    } catch (error) {
        console.error('Error sending email:', error);
        res.status(500).send('Error sending email.');
    }
});

// endpoint to register the newsletter in Firestore
app.post('/register-newsletter', async (req: Request, res: Response) => {
    const { name, recipientList, attachmentPath, subject, text } = req.body;
  
    if (!name || !Array.isArray(recipientList) || recipientList.length === 0 || !attachmentPath) {
      return res.status(400).send('Name, recipient list, and attachment path are required.');
    }
  
    try {
      const newsletterData = {
        name,
        recipientList,
        attachmentPath,
        subject,
        text,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };
  
      await firestore.collection('newsletters').add(newsletterData);
      res.status(200).send('Newsletter registered successfully!');
    } catch (error) {
      console.error('Error registering newsletter:', error);
      res.status(500).send('Error registering newsletter.');
    }
  });

// endpoint to unsubscribe
app.get('/unsubscribe', (req: Request, res: Response) => {
  const email = req.query.email as string;

  if (email) {
    // Logic to handle unsubscription
    res.send(`Email ${email} has been unsubscribed.`);
  } else {
    res.status(400).send('Email is required to unsubscribe.');
  }
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
