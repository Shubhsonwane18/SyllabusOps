import express from 'express';
import path from 'path';
import multer from 'multer';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';
import dotenv from 'dotenv';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

dotenv.config();

const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });

// Lazy Gemini client helper
let aiClient: GoogleGenAI | null = null;
function getAI(): GoogleGenAI | null {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      aiClient = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });
    }
  }
  return aiClient;
}

// Algebraic solver implementation on server
function solveTargetGrade(current_grade_pct: number, completed_weight_pct: number, target_grade_pct: number) {
  const W_c = completed_weight_pct;
  const G_c = current_grade_pct;
  const G_t = target_grade_pct;
  const W_r = Math.max(0, 1.0 - W_c);

  if (W_r <= 0.0001) {
    const finalScore = G_c * W_c;
    return {
      status: 'success',
      completed_weight_pct: W_c,
      remaining_weight_pct: 0,
      current_grade_pct: G_c,
      target_grade_pct: G_t,
      required_average_on_remaining: 0,
      required_average_formatted: '0.00% (Course Finished)',
      is_achievable: finalScore >= G_t,
      note: `All coursework (100%) is finished. Final locked grade: ${(finalScore * 100).toFixed(2)}%.`,
    };
  }

  const pointsEarned = G_c * W_c;
  const pointsNeeded = G_t - pointsEarned;
  const S_r = pointsNeeded / W_r;

  return {
    status: 'success',
    current_grade_pct: G_c,
    completed_weight_pct: W_c,
    remaining_weight_pct: W_r,
    target_grade_pct: G_t,
    points_earned_so_far: pointsEarned,
    points_needed_from_remaining: pointsNeeded,
    required_average_on_remaining: S_r,
    required_average_formatted: S_r <= 0 ? '0.00% (Already Secured!)' : `${(S_r * 100).toFixed(2)}%`,
    is_achievable: S_r <= 1.0,
    formula: 'S_r = (G_t - (G_c * W_c)) / (1.0 - W_c)',
  };
}

// Study block scheduler heuristic
function allocateStudyBlocks(assignment_name: string, due_date: string, weight_pct: number) {
  const totalHours = Math.max(2, Math.floor(weight_pct * 20));
  let dueDateObj: Date;
  try {
    dueDateObj = due_date ? new Date(due_date) : new Date();
    if (isNaN(dueDateObj.getTime())) {
      dueDateObj = new Date();
      dueDateObj.setDate(dueDateObj.getDate() + 7);
    }
  } catch {
    dueDateObj = new Date();
    dueDateObj.setDate(dueDateObj.getDate() + 7);
  }

  const sessions: Array<{
    dayOffset: number;
    hours: number;
    phase: string;
    topic: string;
    startTime: string;
    endTime: string;
  }> = [];

  if (totalHours <= 2) {
    sessions.push({
      dayOffset: -1,
      hours: 2,
      phase: 'Final Polish & Review',
      topic: `Comprehensive review & key practice for ${assignment_name}`,
      startTime: '18:00',
      endTime: '20:00',
    });
  } else if (totalHours <= 4) {
    sessions.push(
      {
        dayOffset: -2,
        hours: 2,
        phase: 'Concept Review',
        topic: `Theory consolidation & formula derivation for ${assignment_name}`,
        startTime: '16:00',
        endTime: '18:00',
      },
      {
        dayOffset: -1,
        hours: 2,
        phase: 'Deep Practice',
        topic: `Problem sets & mock problems for ${assignment_name}`,
        startTime: '17:00',
        endTime: '19:00',
      }
    );
  } else if (totalHours <= 6) {
    sessions.push(
      {
        dayOffset: -3,
        hours: 2,
        phase: 'Concept Review',
        topic: `High-yield syllabus synthesis for ${assignment_name}`,
        startTime: '15:00',
        endTime: '17:00',
      },
      {
        dayOffset: -2,
        hours: 2,
        phase: 'Deep Practice',
        topic: `Timed practice exam & error logs for ${assignment_name}`,
        startTime: '16:00',
        endTime: '18:00',
      },
      {
        dayOffset: -1,
        hours: 2,
        phase: 'Final Polish & Review',
        topic: `Flashcards, summary sheet & edge-cases for ${assignment_name}`,
        startTime: '18:00',
        endTime: '20:00',
      }
    );
  } else {
    const perSession = Math.round(totalHours / 4);
    sessions.push(
      {
        dayOffset: -5,
        hours: perSession,
        phase: 'Concept Review',
        topic: `Comprehensive textbook & lecture synthesis for ${assignment_name}`,
        startTime: '14:00',
        endTime: `${14 + perSession}:00`,
      },
      {
        dayOffset: -3,
        hours: perSession,
        phase: 'Deep Practice',
        topic: `Challenging problem sets & algorithmic proofs for ${assignment_name}`,
        startTime: '15:00',
        endTime: `${15 + perSession}:00`,
      },
      {
        dayOffset: -2,
        hours: perSession,
        phase: 'Mock Exam / Milestone',
        topic: `Full mock test simulation under strict time limits for ${assignment_name}`,
        startTime: '15:00',
        endTime: `${15 + perSession}:00`,
      },
      {
        dayOffset: -1,
        hours: Math.max(1, totalHours - perSession * 3),
        phase: 'Final Polish & Review',
        topic: `Final formula sheet, weak spot remediation & mental readiness for ${assignment_name}`,
        startTime: '17:00',
        endTime: `${17 + Math.max(1, totalHours - perSession * 3)}:00`,
      }
    );
  }

  const blocks = sessions.map((s, idx) => {
    const sDate = new Date(dueDateObj);
    sDate.setDate(sDate.getDate() + s.dayOffset);
    return {
      id: `block-${assignment_name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${idx + 1}`,
      assignment_name,
      date: sDate.toISOString().split('T')[0],
      day_offset_from_due: s.dayOffset,
      start_time: s.startTime,
      end_time: s.endTime,
      duration_hours: s.hours,
      topic_focus: s.topic,
      phase: s.phase,
      suggested_pomodoros: Math.max(1, Math.round((s.hours * 60) / 30)),
      status: 'pending',
    };
  });

  return {
    assignment_name,
    weight_pct,
    due_date,
    total_study_hours: totalHours,
    blocks_count: blocks.length,
    study_blocks: blocks,
  };
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // PDF Ingestion Endpoint (Extracts text buffer from uploaded PDF file)
  app.post('/api/upload-pdf', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No PDF file uploaded' });
      }

      let extractedText = '';
      try {
        const data = await pdfParse(req.file.buffer);
        extractedText = data.text || '';
      } catch (parseErr) {
        console.warn('pdf-parse fallback, reading as buffer string:', parseErr);
        extractedText = req.file.buffer.toString('utf-8');
      }

      res.json({
        status: 'success',
        filename: req.file.originalname,
        raw_text_length: extractedText.length,
        extracted_text: extractedText,
      });
    } catch (err: any) {
      console.error('Error extracting PDF:', err);
      res.status(500).json({ error: err?.message || 'Failed to parse PDF' });
    }
  });

  // Structured Syllabus Entity Extraction Endpoint
  app.post('/api/parse-syllabus', async (req, res) => {
    try {
      const { raw_text } = req.body;
      if (!raw_text || typeof raw_text !== 'string' || raw_text.trim().length === 0) {
        return res.status(400).json({ error: 'raw_text string is required' });
      }

      const ai = getAI();
      if (!ai) {
        return res.status(500).json({ error: 'GEMINI_API_KEY environment variable is not configured' });
      }

      const prompt = `Extract all structured academic course entities from the following syllabus document text.
Extract:
- Course code (e.g. CS101, MATH202)
- Course title
- Instructor details (name, email, office hours, location)
- Term / Quarter / Semester
- Grading categories with exact weight decimals (e.g. 0.20 for 20%)
- Assignments list with name, category, due date (YYYY-MM-DD or readable string), weight decimal (e.g. 0.06 for 6%), and description.
- Key course policies (late policy, attendance, grade drops).

Syllabus Text:
"""
${raw_text.slice(0, 30000)}
"""`;

      const response = await ai.models.generateContent({
        model: 'gemini-3.7-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              course_code: { type: Type.STRING },
              course_title: { type: Type.STRING },
              instructor: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  email: { type: Type.STRING },
                  office_hours: { type: Type.STRING },
                  location: { type: Type.STRING },
                },
                required: ['name'],
              },
              term: { type: Type.STRING },
              grading_categories: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING },
                    weight_pct: { type: Type.NUMBER },
                    description: { type: Type.STRING },
                  },
                  required: ['name', 'weight_pct'],
                },
              },
              assignments: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    name: { type: Type.STRING },
                    category: { type: Type.STRING },
                    due_date: { type: Type.STRING },
                    weight_pct: { type: Type.NUMBER },
                    description: { type: Type.STRING },
                  },
                  required: ['name', 'category', 'due_date', 'weight_pct'],
                },
              },
              key_policies: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
            },
            required: ['course_code', 'course_title', 'instructor', 'grading_categories', 'assignments'],
          },
        },
      });

      const parsed = JSON.parse(response.text?.trim() || '{}');
      // Ensure ids are present on assignments
      if (Array.isArray(parsed.assignments)) {
        parsed.assignments = parsed.assignments.map((a: any, i: number) => ({
          ...a,
          id: a.id || `asgn-${i + 1}`,
          is_completed: false,
        }));
      }

      res.json({ status: 'success', structured: parsed });
    } catch (err: any) {
      console.error('Error in parse-syllabus:', err);
      res.status(500).json({ error: err?.message || 'Failed to parse syllabus' });
    }
  });

  // Target Grade Calculation Tool Endpoint
  app.post('/api/calculate-grade', (req, res) => {
    const { current_grade_pct, completed_weight_pct, target_grade_pct } = req.body;
    const G_c = typeof current_grade_pct === 'number' ? current_grade_pct : 0.85;
    const W_c = typeof completed_weight_pct === 'number' ? completed_weight_pct : 0.40;
    const G_t = typeof target_grade_pct === 'number' ? target_grade_pct : 0.90;

    const result = solveTargetGrade(G_c, W_c, G_t);
    res.json(result);
  });

  // Study Blocks Scheduler Tool Endpoint
  app.post('/api/schedule-blocks', (req, res) => {
    const { assignment_name, due_date, weight_pct } = req.body;
    const name = assignment_name || 'Upcoming Assignment';
    const due = due_date || new Date().toISOString().split('T')[0];
    const weight = typeof weight_pct === 'number' ? weight_pct : 0.20;

    const result = allocateStudyBlocks(name, due, weight);
    res.json(result);
  });

  // Autonomous ReAct Agent Loop Endpoint (Strands Agents SDK Pattern)
  app.post('/api/agent', async (req, res) => {
    try {
      const {
        prompt: userPrompt,
        syllabus_text,
        current_grade_pct,
        completed_weight_pct,
        target_grade_pct,
        chat_history,
      } = req.body;

      const ai = getAI();
      if (!ai) {
        return res.status(500).json({ error: 'GEMINI_API_KEY is not configured' });
      }

      // Define Strands Tool Declarations
      const extractSyllabusDeclaration = {
        name: 'extract_syllabus_data',
        description:
          'Parses raw syllabus text or PDF stream to extract assignment names, due dates, grading categories, and weight percentages.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            syllabus_query: {
              type: Type.STRING,
              description: 'Focus query or syllabus reference string.',
            },
          },
        },
      };

      const calculateTargetGradeDeclaration = {
        name: 'calculate_target_grade',
        description:
          'Implements exact linear algebraic grade forecasting: S_r = (G_t - (G_c * W_c)) / (1.0 - W_c). Computes exact required percentage average on remaining coursework to reach target grade.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            current_grade_pct: {
              type: Type.NUMBER,
              description: 'Current average on completed work as decimal (e.g. 0.85 for 85%).',
            },
            completed_weight_pct: {
              type: Type.NUMBER,
              description: 'Fraction of course grade completed so far (e.g. 0.40 for 40%).',
            },
            target_grade_pct: {
              type: Type.NUMBER,
              description: 'Desired final course percentage score (e.g. 0.90 for 90%).',
            },
          },
          required: ['current_grade_pct', 'completed_weight_pct', 'target_grade_pct'],
        },
      };

      const scheduleStudyBlocksDeclaration = {
        name: 'schedule_study_blocks',
        description:
          'Calculates backward-planned prep study sessions scaled to assignment weights: Scheduled Hours H = max(2, floor(W * 20)). Allocates study sessions leading up to due date.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            assignment_name: {
              type: Type.STRING,
              description: 'Name of the exam, project, or homework.',
            },
            due_date: {
              type: Type.STRING,
              description: 'Due date in YYYY-MM-DD or readable date.',
            },
            weight_pct: {
              type: Type.NUMBER,
              description: 'Course grade weight as decimal (e.g. 0.25 for 25%).',
            },
          },
          required: ['assignment_name', 'due_date', 'weight_pct'],
        },
      };

      const systemInstruction = `You are SyllabusOps, an autonomous college academic operations assistant built with the Strands Agents SDK ReAct execution loop.
Your role is to assist students with course management through a 3-step pipeline:

1. PARSING: When a syllabus document/text is uploaded or referenced, invoke the \`extract_syllabus_data\` tool. Convert unstructured syllabus text into clear summaries of assignment names, due dates, and grading percentage weights.
2. GRADE FORECASTING: When asked about grade goals (e.g., "What do I need to get an A?", "Can I still pass?"), invoke the \`calculate_target_grade\` tool to compute exact weighted scores required on remaining coursework using linear algebra: S_r = (G_t - (G_c * W_c)) / (1.0 - W_c).
3. CALENDAR SCHEDULING: When scheduling assignments, invoke the \`schedule_study_blocks\` tool. Calculate backward-planned study sessions scaled to assignment weights: Scheduled Hours H = max(2, floor(W * 20)).

CONSTRAINTS:
- Always format outputs in clear Markdown tables or bullet points.
- If data is ambiguous in the syllabus, state assumptions clearly.
- Always use the tools provided rather than manually approximating math.
- In your reasoning, clearly articulate Thoughts, Action decisions, and Observations.

Context:
${syllabus_text ? `Current Loaded Syllabus Text:\n"""\n${syllabus_text.slice(0, 15000)}\n"""` : 'No syllabus text loaded yet.'}
${typeof current_grade_pct === 'number' ? `Known Current Grade: ${(current_grade_pct * 100).toFixed(1)}%` : ''}
${typeof completed_weight_pct === 'number' ? `Known Completed Weight: ${(completed_weight_pct * 100).toFixed(1)}%` : ''}
${typeof target_grade_pct === 'number' ? `Target Grade Goal: ${(target_grade_pct * 100).toFixed(1)}%` : ''}`;

      const reactSteps: Array<{
        type: 'thought' | 'action' | 'observation' | 'answer';
        content: string;
        tool_name?: any;
        tool_args?: any;
        tool_output?: any;
        timestamp: number;
      }> = [];

      // Step 1: Initial call to Gemini with tools
      const response1 = await ai.models.generateContent({
        model: 'gemini-3.7-flash',
        contents: userPrompt,
        config: {
          systemInstruction,
          tools: [
            {
              functionDeclarations: [
                extractSyllabusDeclaration,
                calculateTargetGradeDeclaration,
                scheduleStudyBlocksDeclaration,
              ],
            },
          ],
        },
      });

      let finalAnswer = response1.text || '';
      const functionCalls = response1.functionCalls;

      if (functionCalls && functionCalls.length > 0) {
        const toolResponses: any[] = [];

        for (const call of functionCalls) {
          const toolName = call.name;
          const args = (call.args || {}) as Record<string, any>;

          reactSteps.push({
            type: 'thought',
            content: `Agent identified the need to call tool \`${toolName}\` with parameters: ${JSON.stringify(args)}`,
            timestamp: Date.now(),
          });

          reactSteps.push({
            type: 'action',
            tool_name: toolName as any,
            tool_args: args,
            content: `Invoking ${toolName}(${JSON.stringify(args)})`,
            timestamp: Date.now(),
          });

          let toolOutput: any = null;

          if (toolName === 'calculate_target_grade') {
            const g_c = typeof args.current_grade_pct === 'number' ? args.current_grade_pct : (current_grade_pct ?? 0.85);
            const w_c = typeof args.completed_weight_pct === 'number' ? args.completed_weight_pct : (completed_weight_pct ?? 0.40);
            const g_t = typeof args.target_grade_pct === 'number' ? args.target_grade_pct : (target_grade_pct ?? 0.90);
            toolOutput = solveTargetGrade(g_c, w_c, g_t);
          } else if (toolName === 'schedule_study_blocks') {
            const name = args.assignment_name || 'Upcoming Exam';
            const due = args.due_date || new Date().toISOString().split('T')[0];
            const weight = typeof args.weight_pct === 'number' ? args.weight_pct : 0.20;
            toolOutput = allocateStudyBlocks(name, due, weight);
          } else if (toolName === 'extract_syllabus_data') {
            toolOutput = {
              status: 'extracted',
              raw_text_length: syllabus_text ? syllabus_text.length : 0,
              summary: 'Syllabus text loaded into buffer.',
              snippet: syllabus_text ? syllabus_text.slice(0, 500) + '...' : 'No text available',
            };
          }

          reactSteps.push({
            type: 'observation',
            tool_name: toolName as any,
            tool_output: toolOutput,
            content: `Observation from ${toolName}: ${JSON.stringify(toolOutput)}`,
            timestamp: Date.now(),
          });

          toolResponses.push({
            response: {
              name: toolName,
              content: toolOutput,
            },
          });
        }

        // Re-feed tool execution results back to model for Final Synthesis
        const followUpContents = [
          { role: 'user', parts: [{ text: userPrompt }] },
          {
            role: 'model',
            parts: functionCalls.map((fc) => ({
              functionCall: { name: fc.name, args: fc.args },
            })),
          },
          {
            role: 'user',
            parts: toolResponses.map((tr) => ({
              functionResponse: {
                name: tr.response.name,
                response: tr.response.content,
              },
            })),
          },
        ];

        const response2 = await ai.models.generateContent({
          model: 'gemini-3.7-flash',
          contents: followUpContents as any,
          config: {
            systemInstruction,
          },
        });

        finalAnswer = response2.text || finalAnswer;
      } else {
        reactSteps.push({
          type: 'thought',
          content: 'Agent reasoned directly on provided syllabus context without secondary tool invocation.',
          timestamp: Date.now(),
        });
      }

      reactSteps.push({
        type: 'answer',
        content: finalAnswer,
        timestamp: Date.now(),
      });

      res.json({
        status: 'success',
        answer: finalAnswer,
        react_steps: reactSteps,
      });
    } catch (err: any) {
      console.error('Agent execution error:', err);
      res.status(500).json({ error: err?.message || 'Agent failed to execute' });
    }
  });

  // Vite development middleware or static serving
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SyllabusOps backend running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
