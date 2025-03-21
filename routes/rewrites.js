const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate } = require('../middleware/auth'); 
const { updateUserCredits, fetchUserCredits } = require('../services/credits');
const rewriteJobQueue = require('../services/rewriteQueue');

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
            const result = rewriteJobQueue.results[jobId];
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
    
    // processed docs
    let tokenJdArr = [];
    let user_resume = '';
    
    // check user's credit balance first
    const creditBalance = await fetchUserCredits(userId);
    // console.log(`creditBalance: ${creditBalance}`)
    if (!creditBalance || creditBalance <= 0){
        return res.status(400).json({ error: 'You have insufficient credits. Please buy more before trying again.' });
    }
    
    if (!jd1 || !jd2 || !jd3) {
        return res.status(400).json({ error: 'Job descriptions are required' });
    }
    
    // remove the extraneous text from the job descriptions.
    // this distills them to the significant parts for the AI to focus on.
    const jdArr = [...Object.values(req.body)];
    const promises = jdArr.map(async (jd) => {
        let conversation = [
            {
                role: 'system',
                content: FINAL_SYSTEM_PROMPT,
            },
            {
                role: 'user',
                content: `${jd}` + TOKENIZE_PROMPT,
            },
        ];
        
        try {
            const tokenizeResponse = await callOpenAI(OPENAI_API_KEY, MODEL, conversation);
            return tokenizeResponse[0]?.message?.content; // Return the tokenJd for this promise
        } catch (error) {
            console.error("Error calling OpenAI:", error);
            throw new Error('An error occurred while processing the request'); // Throw error to capture in Promise.all
        }
    });
    
    try {
        tokenJdArr = await Promise.all(promises); // Execute all API calls in parallel
        
        
        const [tokenJd1, tokenJd2, tokenJd3]  = tokenJdArr;
        let FINAL_DRAFT_PROMPT = `<job description 1>${tokenJd1}</job description 1>`;
        FINAL_DRAFT_PROMPT += `\n<job description 2>${tokenJd2}</job description 2>`;
        FINAL_DRAFT_PROMPT += `\n<job description 3>${tokenJd3}</job description 3>`;
        FINAL_DRAFT_PROMPT += '\n' + DRAFT_PROMPT;
        
        // Step 1: Conversation Flow with OpenAI
        // Initial conversation with OpenAI
        let conversation = [
            {
                role: 'system',
                content: FINAL_SYSTEM_PROMPT,
                role: "user",
                content: FINAL_DRAFT_PROMPT,
            },
        ];
        
        // First prompt: Draft
        const draftResponse = await callOpenAI(OPENAI_API_KEY, MODEL, conversation);
        user_resume = draftResponse[0]?.message?.content;
        
        // Step 1: Create a new DocCollection  
        const collection = await prisma.docCollection.create({
            data: {
                userResume: user_resume.replace('```markdown', "").replace('```', ""),
                jd: "JD1:\n\n" + tokenJd1 + "\n\nJD2:\n\n" + tokenJd2 + "\n\nJD3:\n\n" + tokenJd3,
                collectionName: "Draft - " + getCurrentDateTime(),
            },
        });
        
        const collectionId = collection.id;
        
        // Step 2: Create Docs for the User Resume and Job Description
        const userResumeDoc = await prisma.docs.create({
            data: {
                userId: req.user.id,
                docType: 'USER_RESUME',
                content: user_resume.replace('```markdown', "").replace('```', ""),
                collectionId,
            },
        });
        
        const jdDoc = await prisma.docs.create({
            data: {
                userId: req.user.id,
                docType: 'JD',
                content: "JD1:\n\n" + tokenJd1 + "JD2:\n\n" + tokenJd2 + "JD3:\n\n" + tokenJd3,
                collectionId,
            },
        });
        
        
        // First prompt: Analysis
        const analysisResponse = await callOpenAI(OPENAI_API_KEY, MODEL, conversation);
        const analysisContent = analysisResponse[0]?.message?.content;
        
        // Save the analysis as a Doc
        const analysisDoc = await prisma.docs.create({
            data: {
                userId: req.user.id,
                docType: 'ANALYSIS',
                content: analysisContent.replace('```markdown', "").replace('```', ""),
                collectionId,
            },
        });
        
        // Append assistant's response to the conversation
        conversation.push({
            role: "assistant",
            content: analysisContent,
        });
        
        // Second prompt: Rewrite Resume
        conversation.push({
            role: "user",
            content: `${COMPARE_PROMPT}${user_resume}`,
        });
        
        const rewriteResponse = await callOpenAI(OPENAI_API_KEY, MODEL, conversation);
        const rewriteContent = rewriteResponse[0]?.message?.content;
        
        // Save the rewritten resume as a Doc
        const rewriteDoc = await prisma.docs.create({
            data: {
                userId: req.user.id,
                docType: 'REWRITE_RESUME',
                content: rewriteContent.replace('```markdown', "").replace('```', ""),
                collectionId,
            },
        });
        
        // Append assistant's response to the conversation
        conversation.push({
            role: "assistant",
            content: rewriteContent,
        });
        
        // Third prompt: Cover Letter
        conversation.push({
            role: "user",
            content: `${COVERLETTER_PROMPT}`,
        });
        
        const coverLetterResponse = await callOpenAI(OPENAI_API_KEY, MODEL, conversation);
        const coverLetterContent = coverLetterResponse[0]?.message?.content;
        
        // Save the cover letter as a Doc
        const coverLetterDoc = await prisma.docs.create({
            data: {
                userId: req.user.id,
                docType: 'COVER_LETTER',
                content: coverLetterContent.replace('```markdown', "").replace('```', ""),
                collectionId,
            },
        });
        
        // Draft takes 5 credits
        await updateUserCredits(req.user.id, 5, 'decrement');
        
        // Step 4: Respond with the created collection and docs
        res.status(201).json({
            collectionId,
            docs: [
                { id: userResumeDoc.id, docType: 'USER_RESUME' },
                { id: jdDoc.id, docType: 'JD' },
                { id: analysisDoc.id, docType: 'ANALYSIS' },
                { id: rewriteDoc.id, docType: 'REWRITE_RESUME' },
                { id: coverLetterDoc.id, docType: 'COVER_LETTER' },
            ],
        });
    } catch (error) {
        console.error('Error creating document collection:', error);
        
        res.status(500).json({ error: 'An error occurred while processing the request' });
    }
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