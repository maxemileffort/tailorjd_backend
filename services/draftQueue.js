const { PrismaClient } = require('@prisma/client');
const { updateUserCredits, fetchUserCredits } = require('./credits');
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
let ANALYSIS_PROMPT = Buffer.from(process.env.ANALYSIS_PROMPT, 'base64').toString('utf-8') ;
let COMPARE_PROMPT = Buffer.from(process.env.COMPARE_PROMPT, 'base64').toString('utf-8') ;
let COVERLETTER_PROMPT = Buffer.from(process.env.COVERLETTER_PROMPT, 'base64').toString('utf-8') ;

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
    
    const json = await response.json();
    
    if (!json.choices) {
        throw new Error(`OpenAI API Error: Response is missing choices.`);
    }
    
    return json.choices;
}

class SimpleDraftQueue {
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
        const { userId, jd1, jd2, jd3 } = job;
        
        try {
            const creditBalance = await fetchUserCredits(userId);
            if (!creditBalance || creditBalance <= 0) {
                await prisma.jobs.update({
                    where: { jobId },
                    data: {
                        status: 'FAILED',
                        errorMessage: 'You have insufficient credits.',
                    },
                });
                return;
            }
            
            if (!jd1 || !jd2 || !jd3) {
                await prisma.jobs.update({
                    where: { jobId },
                    data: {
                        status: 'FAILED',
                        errorMessage: 'Job descriptions are required.',
                    },
                });
                return;
            }
            
            const jdArr = [jd1, jd2, jd3];
            const tokenJdArr = await Promise.all(
                jdArr.map(async (jd) => {
                    const conversation = [
                        { role: 'system', content: FINAL_SYSTEM_PROMPT },
                        { role: 'user', content: `${jd}${TOKENIZE_PROMPT}` },
                    ];
                    const tokenizeResponse = await callOpenAI(OPENAI_API_KEY, MODEL, conversation);
                    return tokenizeResponse[0]?.message?.content;
                })
            );
            
            const [tokenJd1, tokenJd2, tokenJd3] = tokenJdArr;
            let FINAL_DRAFT_PROMPT = `<job description 1>${tokenJd1}</job description 1>`;
            FINAL_DRAFT_PROMPT += `\n<job description 2>${tokenJd2}</job description 2>`;
            FINAL_DRAFT_PROMPT += `\n<job description 3>${tokenJd3}</job description 3>\n${DRAFT_PROMPT}`;
            
            let conversation = [
                { role: 'system', content: FINAL_SYSTEM_PROMPT },
                { role: 'user', content: FINAL_DRAFT_PROMPT },
            ];
            
            const draftContent = await handleOpenAI(conversation, 'USER_RESUME');
            const collection = await prisma.docCollection.create({
                data: {
                    userResume: draftContent,
                    jd: `JD1:\n\n${tokenJd1}\n\nJD2:\n\n${tokenJd2}\n\nJD3:\n\n${tokenJd3}`,
                    collectionName: `Draft - ${getCurrentDateTime()}`,
                },
            });
            
            const collectionId = collection.id;
            
            await createDoc(userId, 'USER_RESUME', draftContent, collectionId);
            await createDoc(userId, 'JD', `JD1:\n\n${tokenJd1}\nJD2:\n\n${tokenJd2}\nJD3:\n\n${tokenJd3}`, collectionId);
            
            const analysisContent = await handleOpenAI(conversation, 'ANALYSIS');
            conversation.push({ role: 'assistant', content: analysisContent });
            await createDoc(userId, 'ANALYSIS', analysisContent, collectionId);
            
            conversation.push({ role: 'user', content: `${COMPARE_PROMPT}${draftContent}` });
            const rewriteContent = await handleOpenAI(conversation, 'REWRITE_RESUME');
            conversation.push({ role: 'assistant', content: rewriteContent });
            await createDoc(userId, 'REWRITE_RESUME', rewriteContent, collectionId);
            
            conversation.push({ role: 'user', content: COVERLETTER_PROMPT });
            const coverLetterContent = await handleOpenAI(conversation, 'COVER_LETTER');
            await createDoc(userId, 'COVER_LETTER', coverLetterContent, collectionId);
            
            await updateUserCredits(userId, 5, 'decrement');
            
            await prisma.jobs.update({
                where: { jobId },
                data: {
                    status: 'COMPLETED',
                },
            });
            
        } catch (error) {
            console.error('Error processing job:', error);
            await prisma.jobs.update({
                where: { jobId },
                data: {
                    status: 'FAILED',
                    errorMessage: error.message || 'Unknown error',
                },
            });
        }
        
        console.log(`Finished processing job for user ${job.userId}`);
    }
    
}

const draftJobQueue = new SimpleDraftQueue();
module.exports = draftJobQueue;

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
