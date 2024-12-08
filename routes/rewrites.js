const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate } = require('../middleware/auth'); 
const { updateUserCredits } = require('../services/credits');

// Example usage

const router = express.Router();
const prisma = new PrismaClient();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = 'gpt-4o-mini';

// Protect our prompting strategy here.
let SYSTEM_PROMPT = process.env.SYSTEM_PROMPT;
let GUARDRAIL_PROMPT1 = process.env.GUARDRAIL_PROMPT1;
let GUARDRAIL_PROMPT2 = process.env.GUARDRAIL_PROMPT2;
let GUARDRAIL_PROMPT3 = process.env.GUARDRAIL_PROMPT3;
let FINAL_SYSTEM_PROMPT = SYSTEM_PROMPT + GUARDRAIL_PROMPT1 + GUARDRAIL_PROMPT2 + GUARDRAIL_PROMPT3;

// Prompts for Rewrites
let ANALYSIS_PROMPT = process.env.ANALYSIS_PROMPT;
let COMPARE_PROMPT = process.env.COMPARE_PROMPT;
let COVERLETTER_PROMPT = process.env.COVERLETTER_PROMPT;

// Prompts for Drafts
let TOKENIZE_PROMPT = process.env.TOKENIZE_PROMPT;
let DRAFT_PROMPT = process.env.DRAFT_PROMPT;

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
    
    if (!response.ok) {
        throw new Error(`OpenAI API Error: ${response.status} - ${response.statusText}`);
    }
    
    const json = await response.json();
    return json.choices;
}

router.post('/', authenticate, async (req, res) => {
    console.log('received request')
    const { user_resume, jd } = req.body;
    
    if (!user_resume || !jd) {
        return res.status(400).json({ error: 'User resume and job description are required' });
    }
    
    try {
        // Step 1: Create a new DocCollection
        const collection = await prisma.docCollection.create({
            data: {
                userResume: user_resume,
                jd: jd,
                collectionName: "Rewrite - " + getCurrentDateTime(),
            },
        });
        
        const collectionId = collection.id;
        
        // Step 2: Create Docs for the User Resume and Job Description
        const userResumeDoc = await prisma.docs.create({
            data: {
                userId: req.user.id,
                docType: 'USER_RESUME',
                content: user_resume,
                collectionId,
            },
        });
        
        const jdDoc = await prisma.docs.create({
            data: {
                userId: req.user.id,
                docType: 'JD',
                content: jd,
                collectionId,
            },
        });
        
        // Step 3: Conversation Flow with OpenAI
        // Initial conversation with OpenAI
        let conversation = [
            {
                role: 'system',
                content: FINAL_SYSTEM_PROMPT,
                role: "user",
                content: `${ANALYSIS_PROMPT}${jd}`,
            },
        ];
        
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
        
        // Charge user a credit
        await updateUserCredits(req.user.id, 1, 'decrement');
        
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
        
        // Handle OpenAI-specific 401 errors
        // if (error.message.includes('401')) {
        //     return res.status(401).json({ error: 'OpenAI API: Unauthorized. API Key Issue.' });
        // }
        
        res.status(500).json({ error: 'An error occurred while processing the request' });
    }
});

router.post('/draft', authenticate, async (req, res) => {
    // raw jds
    const { jd1, jd2, jd3 } = req.body;
    
    // processed docs
    let tokenJdArr = [];
    let user_resume = '';
    
    if (!jd1 || !jd2 || !jd3) {
        return res.status(400).json({ error: 'Job descriptions are required' });
    }

    // remove the extraneous text from the job descriptions.
    // this distills them to the significant parts for the AI to focus on.
    const jdArr = [...Object.values(req.body)];
    for (const jd of jdArr) {
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
            const tokenJd = tokenizeResponse[0]?.message?.content;

            tokenJdArr.push(tokenJd);
        } catch (error) {
            console.error("Error calling OpenAI:", error);
            res.status(500).json({ error: 'An error occurred while processing the request' });
            return ;
        }
    }

    const [tokenJd1, tokenJd2, tokenJd3]  = tokenJdArr;
    let FINAL_DRAFT_PROMPT = `<job description 1>${tokenJd1}</job description 1>`;
    FINAL_DRAFT_PROMPT += `\n<job description 2>${tokenJd2}</job description 2>`;
    FINAL_DRAFT_PROMPT += `\n<job description 3>${tokenJd3}</job description 3>`;
    FINAL_DRAFT_PROMPT += '\n' + DRAFT_PROMPT;
    
    try {
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
        const user_resume = draftResponse[0]?.message?.content;

         // Step 1: Create a new DocCollection  
         const collection = await prisma.docCollection.create({
            data: {
                userResume: user_resume.replace('```markdown', "").replace('```', ""),
                jd: "JD1:\n\n" + tokenJd1 + "JD2:\n\n" + tokenJd2 + "JD3:\n\n" + tokenJd3,
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

        // Charge user a credit
        await updateUserCredits(req.user.id, 1, 'decrement');

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
        
        // Handle OpenAI-specific 401 errors
        // if (error.message.includes('401')) {
        //     return res.status(401).json({ error: 'OpenAI API: Unauthorized. API Key Issue.' });
        // }
        
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

module.exports = router;