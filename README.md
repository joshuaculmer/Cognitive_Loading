# Cognitive Loading 


In the learning/software development literature an old fear has emerged stronger than ever, Cognitive Offloading. Cognitive Offloading is the process of lightening the cognitive load for a task. Classic example include physically rotating one's head instead of reading and mentally rotating letters to read a sentence, or using a calculator to perform long division, or a spell checker to replace looking for spelling errors across a 50 page document. In each of these examples a tool was used to simplify the cognitive demands for a particular task. With the development of AI, any process that can be done by an LLM can be offloading to an AI, leading to an over dependence on AI for any task and a lack of involvement in tasks that would have otherwise provided substantial learning opportunities. 

The purpose of this project is to amplify learning opportunities that might have been lost otherwise. To use AI as a tool to learn instead of a tool to finish a task. The driving measure of success then is how much faster can people learn by using AI than without, and how much longer do they remember what they learned. 



## V0

The first version of this project is based on my Socratic Teaching skill and workflows requiring agents to use the Socratic method to question and critique user feedback.



I envision the following workflow:
1. User provides a topic/subject/thing they want to learn more about.
2. Script automatically asks them what they know about the topic.
3. AI Agent further asks the user what they know about the topic given their prior input. 
4. AI Agent pulls in context about the subject (more on this later).
5. AI Agent gives a task/asks a question to the user to deepen their understanding (This step requires the most nuance that will need discussed).
6. User demonstrates understanding/lack thereof and subject context is updated. 
7. User asks another question, restarting the loop or ends once they feel they have a sufficient understanding. 



### Subject Context

Two types of information about the user are kept in a storage (DB lookup or some other hiearchical structure for storing informaiton):
A. Demonstrated knowledge. The user had to successfully answer a series of questions or tasks to demonstrate concrete understanding of a principle.
B. Assumed knowledge. This is what the user says they know. Statements about the user's understanding is categorically different from concepts that they have proven mastery over, they could be true or false and will require verification to move into the demonstrated knowledge. But the AI agent should only push back on assumed knowledge if the AI agent has reason to suspect that the user does not actually understand. Innocent until proven guilty. And the AI Agent does not seek to validate assumed knowledge. If the user proves or disproves their knowledge, then it is marked as incomplete or moved to the demonstrated knowledge.


When teaching a subject/topic, the AI Agent will also need to find further resources to challenge the user's mastery of the topic through the internet. This is expected as is part of the subject context that they AI agent is expected to find before the user is given a task. 


## Smoke test

### Env vars

- `ANTHROPIC_API_KEY` — tutor and LLM grader
- `TYPESAFE_API_KEY` — Jev grader and claim judge
- Without a Jev key, set `grader: "llm"` in `src/config.ts`

### Start

```sh
npm install
npm start -- ann        # or `npm start` and type a username
```

The database lives at `data/cogload.db`. Tasks go to `workspace/<taskId>/`. Tutor and grader errors show a generic message, and their details go to `data/errors.log`. After an error with no task open, type `next` to retry.

### 10-minute walkthrough

1. `npm start -- ann`. Answer the intake question and the tutor's follow-up.
2. Open `workspace/<taskId>/TASK.md`. Edit `solution.ts` or `answer.md`.
3. `ask <question>` about what the task wants. A solution question gets declined.
4. `hint` once.
5. `submit`. Give a confidence (0, 12.5 … 100), then read the grade.
6. On the next task, `quit` without submitting.
7. `npm start -- ann` again. Intake is skipped. Type `status`.
8. `quit`, then `npm run export` and check `data/export.jsonl`. The quit task shows as `abandoned` with its hint count and hints. Export covers all users, and `npm run export -- ann` narrows it to one.

### Live integration tests

```sh
export ANTHROPIC_API_KEY=...
export TYPESAFE_API_KEY=...
npm test
```

The tutor test needs `ANTHROPIC_API_KEY`. The grader fixtures need both keys. Each one is skipped when its keys are missing.
