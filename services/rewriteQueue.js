const { PrismaClient } = require('@prisma/client');
const { updateUserCredits, fetchUserCredits } = require('../services/credits');
const prisma = new PrismaClient();
const { v4: uuidv4 } = require('uuid');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = 'gpt-4o-mini';

// Protect our prompting strategy here.
let SYSTEM_PROMPT = Buffer.from(process.env.SYSTEM_PROMPT, 'base64').toString('utf-8');
let GUARDRAIL_PROMPT1 = Buffer.from(process.env.GUARDRAIL_PROMPT1, 'base64').toString('utf-8');
let GUARDRAIL_PROMPT2 = Buffer.from(process.env.GUARDRAIL_PROMPT2, 'base64').toString('utf-8');
let GUARDRAIL_PROMPT3 = Buffer.from(process.env.GUARDRAIL_PROMPT3, 'base64').toString('utf-8');
let FINAL_SYSTEM_PROMPT = (SYSTEM_PROMPT + GUARDRAIL_PROMPT1 + GUARDRAIL_PROMPT2 + GUARDRAIL_PROMPT3);

// Prompts for Rewrites
let ANALYSIS_PROMPT = Buffer.from(process.env.ANALYSIS_PROMPT, 'base64').toString('utf-8');
let COMPARE_PROMPT = Buffer.from(process.env.COMPARE_PROMPT, 'base64').toString('utf-8');
let COVERLETTER_PROMPT = Buffer.from(process.env.COVERLETTER_PROMPT, 'base64').toString('utf-8');

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
    
    const json = await response.json();
    
    if (!json.choices) {
        throw new Error(`OpenAI API Error: Response is missing choices.`);
    }
    
    return json.choices;
}

class SimpleRewriteQueue {
    constructor() {
        this.queue = [];
        this.isProcessing = false;
        this.results = {};
    }
    
    add(job) {
        const jobId = uuidv4();
        this.queue.push({ job, jobId });
        
        // Insert a new job into the Jobs table 
        // which defaults to PROCESSING.
        prisma.jobs.create({
            data: {
                jobId: jobId,
                jobType: job.jobType, 
            },
        }).catch(error => console.error('Error creating job record:', error));

        this.processQueue();
        return jobId; // Return the unique job ID
    }
    
    async processQueue() {
        if (this.isProcessing) return;
        
        this.isProcessing = true;
        
        while (this.queue.length > 0) {
            const job = this.queue.shift(); // Get the first job
            
            try {
                await this.processJob(job);
            } catch (error) {
                console.error('Error processing job:', error);
            }
        }
        
        this.isProcessing = false;
    }
    
    async processJob({ job, jobId }) {
        const { userId, userResume, jd } = job;

        try {
            // Credit balance check
            const creditBalance = await fetchUserCredits(userId);
            if (!creditBalance || creditBalance <= 0) {
                throw new Error('Insufficient credits');
            }
            
            if (!userResume || !jd) {
                throw new Error('Resume and JD required.');
            }

            console.log(`Processing job for user ${userId}`);
            
            // Your existing document processing logic goes here
            try {
                // Step 1: Create a new DocCollection
                const collection = await prisma.docCollection.create({
                    data: {
                        userResume: userResume,
                        jd: jd,
                        collectionName: `${job.jobType} - ${getCurrentDateTime()}`,
                    },
                });
                
                const collectionId = collection.id;
                
                // Step 2: Create Docs for User Resume and Job Description
                const docsToCreate = [
                    { docType: 'USER_RESUME', content: userResume },
                    { docType: 'JD', content: jd }
                ];
                
                const createdDocs = await Promise.all(docsToCreate.map(doc => 
                    prisma.docs.create({
                        data: {
                            userId,
                            ...doc,
                            collectionId,
                        },
                    })
                ));
                
                const userResumeDoc = createdDocs[0];
                const jdDoc = createdDocs[1];
                
                // Step 3: Conversation Flow with OpenAI
                const conversation = [
                    { role: 'system', content: FINAL_SYSTEM_PROMPT },
                    { role: "user", content: `${ANALYSIS_PROMPT}${jd}` }
                ];
                
                const analysisContent = await handleOpenAI(conversation, 'ANALYSIS');
                const analysisDoc = await createDoc(userId, 'ANALYSIS', analysisContent, collectionId);
                
                conversation.push({ role: "assistant", content: analysisContent });
                
                const rewriteContent = await handleOpenAI([...conversation, { role: "user", content: `${COMPARE_PROMPT}${userResume}` }], 'REWRITE_RESUME');
                const rewriteDoc = await createDoc(userId, 'REWRITE_RESUME', rewriteContent, collectionId);
                
                conversation.push({ role: "assistant", content: rewriteContent });
                
                const coverLetterContent = await handleOpenAI([...conversation, { role: "user", content: `${COVERLETTER_PROMPT}` }], 'COVER_LETTER');
                const coverLetterDoc = await createDoc(userId, 'COVER_LETTER', coverLetterContent, collectionId);
                
                // Charge user a credit
                await updateUserCredits(userId, 3, 'decrement');

                // Update the job status to COMPLETED
                await prisma.jobs.update({
                    where: { jobId: jobId },
                    data: {
                        status: 'COMPLETED',
                        completedOn: new Date(),
                    },
                });

                // Prepare response payload
                const responsePayload = {
                    collectionId,
                    jobId,
                    docs: [
                        { id: userResumeDoc.id, docType: 'USER_RESUME' },
                        { id: jdDoc.id, docType: 'JD' },
                        { id: analysisDoc.id, docType: 'ANALYSIS' },
                        { id: rewriteDoc.id, docType: 'REWRITE_RESUME' },
                        { id: coverLetterDoc.id, docType: 'COVER_LETTER' },
                    ],
                };
                this.results[jobId] = responsePayload;
            } catch (error) {
                console.error('Error creating document collection:', error);
                // Update the job status to FAILED in case of errors
                await prisma.jobs.update({
                    where: { jobId: jobId },
                    data: { status: 'FAILED' },
                });
            }
        } catch (error) {
            console.error('Error processing job:', error);
            this.results[jobId] = { error: 'An error occurred while processing the request' }; // Store error
        }
        
        console.log(`Finished processing job for user ${userId}`);
    }
}

const rewriteJobQueue = new SimpleRewriteQueue();
module.exports = rewriteJobQueue;

// Helper function to handle OpenAI requests
async function handleOpenAI(conversation, docType) {
    const response = await callOpenAI(OPENAI_API_KEY, MODEL, conversation);
    const content = response[0]?.message?.content;
    return content.replace(/```(?:markdown)?|```/g, "").trim(); // Cleanup response
}

// Helper function to create a document
async function createDoc(userId, docType, content, collectionId) {
    return await prisma.docs.create({
        data: {
            userId,
            docType,
            content,
            collectionId,
        },
    });
}
