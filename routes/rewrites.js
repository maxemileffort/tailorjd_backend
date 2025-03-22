const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate } = require('../middleware/auth'); 
const { updateUserCredits, fetchUserCredits } = require('../services/credits');
const rewriteJobQueue = require('../services/rewriteQueue');
const draftJobQueue = require('../services/draftQueue');

const router = express.Router();
const prisma = new PrismaClient();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = 'gpt-4o-mini';

// Protect our prompting strategy here.
let SYSTEM_PROMPT = Buffer.from(process.env.SYSTEM_PROMPT, 'base64').toString('utf-8');
let GUARDRAIL_PROMPT1 = Buffer.from(process.env.GUARDRAIL_PROMPT1, 'base64').toString('utf-8');
let GUARDRAIL_PROMPT2 = Buffer.from(process.env.GUARDRAIL_PROMPT2, 'base64').toString('utf-8');
let GUARDRAIL_PROMPT3 = Buffer.from(process.env.GUARDRAIL_PROMPT3, 'base64').toString('utf-8');
let FINAL_SYSTEM_PROMPT = (SYSTEM_PROMPT + GUARDRAIL_PROMPT1 + GUARDRAIL_PROMPT2 + GUARDRAIL_PROMPT3) ;

// Prompts for Rewrites
let ANALYSIS_PROMPT = Buffer.from(process.env.ANALYSIS_PROMPT, 'base64').toString('utf-8') ;
let COMPARE_PROMPT = Buffer.from(process.env.COMPARE_PROMPT, 'base64').toString('utf-8') ;
let COVERLETTER_PROMPT = Buffer.from(process.env.COVERLETTER_PROMPT, 'base64').toString('utf-8') ;
let BULLET_PROMPT = Buffer.from(process.env.BULLET_PROMPT, 'base64').toString('utf-8') ;

// Prompts for Drafts
let TOKENIZE_PROMPT = Buffer.from(process.env.TOKENIZE_PROMPT, 'base64').toString('utf-8') ;
let DRAFT_PROMPT = Buffer.from(process.env.DRAFT_PROMPT, 'base64').toString('utf-8') ;

function getCurrentDateTime() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0'); // Months are zero-indexed
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} @ ${hours}:${minutes}:${seconds}`;
}

async function callOpenAI(apiKey, model, messages) {
    const url = "https://api.openai.com/v1/chat/completions";
    
    const payload = {
        model: model,
        messages: messages,
    };
    
    const options = {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
    };
    
    const response = await fetch(url, options);
    
    // if (!response.ok) {
    //     throw new Error(`OpenAI API Error: ${response.status} - ${response.statusText}`);
    // }
    
    const json = await response.json();
    
    if (!json.choices) {
        throw new Error(`OpenAI API Error: Response is missing choices.`);
    }
    
    return json.choices;
}

router.get('/job-status/:jobId', async (req, res) => {
    const { jobId } = req.params;
    
    try {
        // Query the Jobs table to get the current status
        const job = await prisma.jobs.findUnique({
            where: {
                jobId: jobId,
            },
        });
        
        if (!job) {
            return res.status(404).json({ error: 'Job not found' });
        }
        
        // If the job is completed or failed, retrieve the result (if any)
        if (job.status === 'COMPLETED' || job.status === 'FAILED') {
            const result = job;
            if (result) {
                // delete rewriteJobQueue.results[jobId]; // Optionally remove it after retrieval
                return res.status(200).json(result); // Respond with result
            }
            return res.status(500).json({ error: 'Job completed but no result found.' });
        }
        
        // If the job is still processing
        return res.status(202).json({ status: job.status });
    } catch (error) {
        console.error('Error fetching job status:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/draft', authenticate, async (req, res) => {
    // raw jds
    const { jd1, jd2, jd3 } = req.body;
    const userId = req.user.id;
    const jobType = 'Draft';

     // Add the job to the in-memory queue
     const newJobId = draftJobQueue.add({
        userId,
        jd1,
        jd2,
        jd3,
        jobType,
    });

    // Drafts take 5 credits
    // this happens in the draftQueue in /services/
    // await updateUserCredits(req.user.id, 5, 'decrement');
    
    // Respond immediately
    return res.status(202).json({ 
        message: 'Your request is being processed in the background.',
        jobId : newJobId,
    });
    
    
});

router.get('/doc-collections', authenticate, async (req, res) => {
    try {
        const collections = await prisma.docCollection.findMany({
            where: {
                docs: {
                    some: {
                        userId: req.user.id,
                    },
                },
            },
            include: {
                docs: true,
            },
        });
        res.json({ collections });
    } catch (error) {
        console.error('Error fetching collections:', error);
        res.status(500).json({ error: 'An error occurred while fetching collections.' });
    }
});

router.put('/doc-collections/update', authenticate, async (req, res) => {
    const { id, newName } = req.body;
    
    // Validate input
    if (!id || !newName) {
        return res.status(400).json({ error: 'ID and newName are required.' });
    }
    
    try {
        // Update the collection name in the database
        const updatedCollection = await prisma.docCollection.update({
            where: { id },
            data: { collectionName: newName },
        });
        
        res.json({ success: true, updatedCollection });
    } catch (error) {
        console.error('Error updating collection name:', error);
        
        if (error.code === 'P2025') {
            // Prisma-specific error code for "record not found"
            return res.status(404).json({ error: 'Collection not found.' });
        }
        
        res.status(500).json({ error: 'An error occurred while updating the collection name.' });
    }
});

router.post('/bulletRewrites', authenticate, async (req, res) => {
    const { user_bullets } = req.body;
    const userId = req.user.id;
    
    const creditBalance = await fetchUserCredits(userId);
    if (!creditBalance || creditBalance <= 0) {
        return res.status(400).json({ error: 'You have insufficient credits. Please buy more before trying again.' });
    }

    let conversation = [
        {
            role: 'system',
            content: FINAL_SYSTEM_PROMPT,
        },
        {
            role: "user",
            content: `${BULLET_PROMPT}\n\n${user_bullets}`
        }
        
    ]
    
    const response = await callOpenAI(OPENAI_API_KEY, MODEL, conversation)
    const bulletContent = response[0]?.message?.content

    // Bullet rewrites take 1 credit
    await updateUserCredits(req.user.id, 1, 'decrement');
    
    // Respond immediately
    return res.status(202).json({ 
        bulletContent
    });
});

router.post('/', authenticate, async (req, res) => {
    const { user_resume, jd } = req.body;
    const userId = req.user.id;
    
    const creditBalance = await fetchUserCredits(userId);
    if (!creditBalance || creditBalance <= 0) {
        return res.status(400).json({ error: 'You have insufficient credits. Please buy more before trying again.' });
    }
    
    if (!user_resume || !jd) {
        return res.status(400).json({ error: 'User resume and job description are required' });
    }
    
    // Add the job to the in-memory queue
    const newJobId = rewriteJobQueue.add({
        userId,
        userResume: user_resume,
        jd,
        jobType: 'Rewrite',
    });

    // Rewrites take 3 credits
    // this happens in the rewriteQueue in /services/
    // await updateUserCredits(req.user.id, 3, 'decrement');
    
    // Respond immediately
    return res.status(202).json({ 
        message: 'Your request is being processed in the background.',
        jobId : newJobId,
    });
});

module.exports = router;