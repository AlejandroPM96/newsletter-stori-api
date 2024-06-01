import express, { Request, Response, NextFunction } from 'express';
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
  storageBucket: process.env.STORAGE_BUCKET_URL  // Your Firebase Storage bucket URL
});

const bucket = admin.storage().bucket();
const firestore = admin.firestore();

const app = express();
const port = 3000;

const cors = require('cors');
const corsOptions ={
    credentials:true,            //access-control-allow-credentials:true
    optionSuccessStatus:200
}
app.use(cors(corsOptions));
// Middleware to parse JSON bodies
app.use(express.json());
const unlinkAsync = promisify(fs.unlink);

export function authenticateToken(req: Request, res: Response, next: NextFunction) {
    
    console.log("req: " + req.body)
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) {
        return res.status(401).json({ message: 'Token is missing' });
    }

    if (token !== process.env.SECURITY_TOKEN) {
        return res.status(403).json({ message: 'Invalid token' });
    }

    next();
}

async function cleanUploadsDir(directory: string) {
    const files = await promisify(fs.readdir)(directory);
    const unlinkPromises = files.map(filename => unlinkAsync(path.join(directory, filename)));
    await Promise.all(unlinkPromises);
}
async function addEmailToNewsletter(name: string, email: string) {
    try {
        // Query to find the document with the specified name
        const querySnapshot = await firestore.collection('newsletters').where('name', '==', name).get();

        if (querySnapshot.empty) {
            throw new Error(`No newsletter found with the name: ${name}`);
        }

        const newsletterDoc = querySnapshot.docs[0];
        const newsletterData = newsletterDoc.data();
        if (newsletterData.recipientList.includes(email)) {
            throw new Error(`Email ${email} is already in the recipient list.`);
        }

        // Add the email to the recipient list
        const updatedRecipientList = [...newsletterData.recipientList, email];

        // Update the document in Firestore
        await newsletterDoc.ref.update({ recipientList: updatedRecipientList });

        return { message: `Email ${email} successfully added to the newsletter ${name}.` };
    } catch (error) {
        console.error('Error adding email to newsletter:', error);
        return {error: error}
    }
}
// Function to remove an email from the newsletter's recipient list
async function removeEmailFromNewsletter(name: string, email: string) {
    try {
        // Query to find the document with the specified name
        const querySnapshot = await firestore.collection('newsletters').where('name', '==', name).get();

        if (querySnapshot.empty) {
        throw new Error(`No newsletter found with the name: ${name}`);
        }

        const newsletterDoc = querySnapshot.docs[0];
        const newsletterData = newsletterDoc.data();
        if (!newsletterData.recipientList.includes(email)) {
            throw new Error(`Email ${email} not found in the recipient list.`);
        }

        // Remove the email from the recipient list
        const updatedRecipientList = newsletterData.recipientList.filter((recipientEmail: string) => recipientEmail !== email);
        const currentUnsubscribeCount = newsletterData.unsubscribeCount || 0;
        const newUnsubscribeCount = currentUnsubscribeCount + 1;
        // Update the document in Firestore
        await newsletterDoc.ref.update({ unsubscribeCount: newUnsubscribeCount, recipientList: updatedRecipientList  });

        return { message: `Email ${email} successfully removed from the newsletter ${name}.` };
    } catch (error) {
        console.error('Error removing email from newsletter:', error);
        return {error: error}
    }
}

// Function to get newsletters with recipient count from Firestore
async function getNewslettersWithRecipientCount() {
    try {
        const querySnapshot = await firestore.collection('newsletters').get();
        const newsletters: { name: string, recipients: number, emailsSent: number, fileName: string, unsubscribeCount: number}[] = [];

        querySnapshot.forEach(doc => {
            const data = doc.data();
            const name = data.name;
            const recipients = Array.isArray(data.recipientList) ? data.recipientList.length : 0;
            const emailsSent = data.sentEmailsCount || 0
            const fileName = data.attachmentPath
            const unsubscribeCount = data.unsubscribeCount
            newsletters.push({ name, recipients, emailsSent, fileName, unsubscribeCount});
        });

        return newsletters;
    } catch (error) {
        console.error('Error fetching newsletters:', error);
        throw error;
    }
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
        pass: process.env.EMAIL_PASS,
        },
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
            path: attachmentPath,
        },
        ],
    };

    await transporter.sendMail(mailOptions);
}

// Route to handle email sending
app.post('/send-newsletter', authenticateToken, async (req: Request, res: Response) => {
    const { name } = req.body;
    const newsletters = await getNewslettersByName(name);
    if (newsletters.length == 0) {
        res.status(200).send('Error no newsletter found with name.' + name);
    }
    const newsletter = newsletters[0]
    console.log('Newsletter to send:', newsletter);
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
    const html = "<div>" + text + "</div> <br /><a href=\"{{unsubscribeUrl}}\">Unsubscribe</a></p>"
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
            html.replace('{{unsubscribeUrl}}', process.env.API_URL + `/unsubscribe?email=${encodeURIComponent(email)}&name=${encodeURIComponent(name)}`),
            destination
        );
        }
        await cleanUploadsDir(path.join(__dirname, 'uploads'));
        // Update Firestore with the count of sent emails
        const querySnapshot = await firestore.collection('newsletters').where('name', '==', name).get();

        if (querySnapshot.empty) {
            throw new Error(`Error finding the newsletter: ${name}`);
        }
        const newsletterDoc = querySnapshot.docs[0];
        const newsletterData = newsletterDoc.data();
        const currentSentEmailsCount = newsletterData.sentEmailsCount || 0;
        const newSentEmailsCount = currentSentEmailsCount + emails.length;

        await newsletterDoc.ref.update({ sentEmailsCount: newSentEmailsCount });
        res.status(200).send('Newsletter sent successfully!');
    } catch (error) {
        console.error('Error sending email:', error);
        res.status(500).send('Error sending email.');
    }
});

// endpoint to register the newsletter in Firestore
app.post('/register-newsletter', async (req: Request, res: Response) => {
    console.log("Registering newsletter: ", req.body)
    const name  = req.body.name;
    const recipientList = req.body.recipientList;
    const attachmentPath = req.body.attachmentPath;
    const subject = req.body.subject;
    const text  = req.body.text;

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

// Endpoint to fetch newsletters
app.get('/newsletters', authenticateToken, async (req: Request, res: Response) => {
    try {
        const newsletters = await getNewslettersWithRecipientCount();
        res.status(200).json(newsletters);
    } catch (error) {
        res.status(500).send('Error fetching newsletters.');
    }
});

// Endpoint to add an email to the newsletter
app.post('/add-email', authenticateToken, async (req, res) => {
    const { name, email } = req.body;

    if (!name || !email) {
        return res.status(400).send('Name and email are required.');
    }

    try {
        const result = await addEmailToNewsletter(name, email);
        res.status(200).send({success: result.message});
    } catch (error) {
        res.status(500).send('Error adding email to the newsletter.');
    }
});


// endpoint to unsubscribe
app.get('/unsubscribe', (req: Request, res: Response) => {
    const email = req.query.email as string;
    const name = req.query.name as string;
    
    if (email && name) {
    // Logic to handle unsubscription
        var response = removeEmailFromNewsletter(name, email)
        res.send( `<p>Email <strong>${email}</strong> has been <u>unsubscribed</u> from the newsletter <strong>${name}</strong></p>`);
    } else {
        res.status(400).send('Email and name is required to unsubscribe.');
    }
});

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
