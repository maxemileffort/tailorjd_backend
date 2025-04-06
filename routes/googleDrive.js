const express = require('express');
const { google } = require('googleapis');
const { PrismaClient } = require('@prisma/client');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// --- Google OAuth Configuration (reuse from auth.js logic) ---
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET_KEY;
let GOOGLE_REDIRECT_URI; 
if(process.env.PROD==="true"){
    GOOGLE_REDIRECT_URI = (process.env.GOOGLE_PROD_REDIRECT_URI);
} else {
    GOOGLE_REDIRECT_URI = (process.env.GOOGLE_TEST_REDIRECT_URI);
}

// Helper function to get an authenticated OAuth2 client for the user
async function getAuthenticatedClient(userId) {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { googleAccessToken: true, googleRefreshToken: true, googleTokenExpiry: true }
    });

    if (!user || !user.googleAccessToken) {
        throw new Error('User not authenticated with Google or access token missing.');
    }

    const oauth2Client = new google.auth.OAuth2(
        GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET,
        GOOGLE_REDIRECT_URI
    );

    oauth2Client.setCredentials({
        access_token: user.googleAccessToken,
        refresh_token: user.googleRefreshToken,
        expiry_date: user.googleTokenExpiry ? user.googleTokenExpiry.getTime() : null,
    });

    // Check if the token is expired or close to expiring (e.g., within 5 minutes)
    const fiveMinutesInMillis = 5 * 60 * 1000;
    if (!user.googleTokenExpiry || user.googleTokenExpiry.getTime() < (Date.now() + fiveMinutesInMillis)) {
        console.log(`Refreshing Google token for user ${userId}`);
        try {
            const { credentials } = await oauth2Client.refreshAccessToken();
            // Update the database with the new token and expiry
            await prisma.user.update({
                where: { id: userId },
                data: {
                    googleAccessToken: credentials.access_token,
                    // Refresh token might not always be returned on refresh, only update if present
                    ...(credentials.refresh_token && { googleRefreshToken: credentials.refresh_token }),
                    googleTokenExpiry: credentials.expiry_date ? new Date(credentials.expiry_date) : null,
                },
            });
            oauth2Client.setCredentials(credentials); // Update the client with new credentials
            console.log(`Google token refreshed successfully for user ${userId}`);
        } catch (refreshError) {
            console.error(`Failed to refresh Google token for user ${userId}:`, refreshError.message);
            // If refresh fails, clear stored tokens to force re-authentication
            await prisma.user.update({
                where: { id: userId },
                data: {
                    googleAccessToken: null,
                    googleRefreshToken: null,
                    googleTokenExpiry: null,
                },
            });
            throw new Error('Failed to refresh Google token. Please reconnect Google Drive.');
        }
    }

    return oauth2Client;
}

// Route to list files from Google Drive, optionally filtering by name
router.get('/files', authenticate, async (req, res) => {
    const { nameQuery } = req.query; // Get optional search query from request

    try {
        const oauth2Client = await getAuthenticatedClient(req.user.id);
        const drive = google.drive({ version: 'v3', auth: oauth2Client });

        // Base query for relevant file types owned by the user
        let driveQuery = "(mimeType='application/pdf' or mimeType='application/vnd.google-apps.document') and 'me' in owners";

        // Add name contains filter if nameQuery is provided
        if (nameQuery && nameQuery.trim() !== '') {
            // Escape single quotes and backslashes in the query term
            const escapedQuery = nameQuery.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            driveQuery += ` and name contains '${escapedQuery}'`;
        }

        // List files using the constructed query
        const response = await drive.files.list({
            pageSize: 50, // Adjust as needed
            fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, iconLink, webViewLink)',
            q: driveQuery,
            orderBy: 'modifiedTime desc', // Show most recent first
        });

        res.json(response.data.files || []);

    } catch (error) {
        console.error('Error listing Google Drive files:', error.message);
        // Send specific error message if token refresh failed
        if (error.message.includes('Failed to refresh Google token')) {
            return res.status(401).json({ error: error.message });
        }
        res.status(500).json({ error: 'Failed to list Google Drive files.' });
    }
});

// Route to download a specific file's content from Google Drive
router.get('/download/:fileId', authenticate, async (req, res) => {
    const { fileId } = req.params;
    if (!fileId) {
        return res.status(400).json({ error: 'File ID is required.' });
    }

    try {
        const oauth2Client = await getAuthenticatedClient(req.user.id);
        const drive = google.drive({ version: 'v3', auth: oauth2Client });

        // Get file metadata first to determine the MIME type
        const fileMetadata = await drive.files.get({
            fileId: fileId,
            fields: 'id, name, mimeType',
        });

        const mimeType = fileMetadata.data.mimeType;
        let downloadStream;
        let responseMimeType = mimeType; // Default to original MIME type

        if (mimeType === 'application/vnd.google-apps.document') {
            // Export Google Docs as PDF (or another format like docx if preferred)
            responseMimeType = 'application/pdf'; // Exporting as PDF
            downloadStream = await drive.files.export({
                fileId: fileId,
                mimeType: responseMimeType, // Export as PDF
            }, { responseType: 'stream' });
        } else if (mimeType === 'application/pdf') {
            // Download PDF files directly
            downloadStream = await drive.files.get(
                { fileId: fileId, alt: 'media' },
                { responseType: 'stream' }
            );
        } else {
            // Handle other potential file types or return an error
            return res.status(400).json({ error: `Unsupported file type: ${mimeType}` });
        }

        // Set the correct content type for the response
        res.setHeader('Content-Type', responseMimeType);
        // Optionally set filename for download
        res.setHeader('Content-Disposition', `attachment; filename="${fileMetadata.data.name}${responseMimeType === 'application/pdf' ? '.pdf' : ''}"`);

        // Pipe the download stream to the response
        downloadStream.data.pipe(res);

        downloadStream.data.on('error', (err) => {
            console.error('Error streaming Google Drive file download:', err.message);
            // Avoid sending further headers if stream fails mid-way
            if (!res.headersSent) {
                res.status(500).json({ error: 'Failed to download file stream.' });
            }
        });

        downloadStream.data.on('end', () => {
            res.end();
        });

    } catch (error) {
        console.error(`Error downloading Google Drive file ${fileId}:`, error.message);
         // Send specific error message if token refresh failed
        if (error.message.includes('Failed to refresh Google token')) {
            return res.status(401).json({ error: error.message });
        }
        if (error.response?.status === 404) {
             return res.status(404).json({ error: 'File not found or access denied.' });
        }
        res.status(500).json({ error: 'Failed to download file from Google Drive.' });
    }
});


module.exports = router;
