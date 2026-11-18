// Keep IDs and instructions stable for released Agents. Give revisions a new ID.
export const builtinSkills = [
  {
    id:'builtin:doc-coauthoring:v1', name:'Document co-authoring', source:'Anthropic',
    source_url:'https://github.com/anthropics/skills/blob/main/skills/doc-coauthoring/SKILL.md',
    description:'Develop proposals, specifications, and decision documents with a reader-focused review.',
    instructions:'Build documents in three passes. First establish the intended reader, the decision or action the document should support, and the evidence on hand. Ask for the most consequential missing detail if it affects the draft. Then propose an outline and write the sections the user requests, separating facts, assumptions, and proposals. Finally reread from the perspective of someone new to the topic. Flag unexplained terms, weak evidence, and unclear next steps. Return a revised draft or specific edits. For a one-shot request, use the context supplied and call out assumptions.'
  },
  {
    id:'builtin:internal-comms:v1', name:'Internal communications', source:'Anthropic',
    source_url:'https://github.com/anthropics/skills/blob/main/skills/internal-comms/SKILL.md',
    description:'Draft status reports, leadership updates, and internal announcements.',
    instructions:'Identify the audience and the requested communication format. Lead with the outcome or decision readers need. For routine status reports, organize facts into completed work, upcoming milestones, and blockers. Pair requests with a responsible person and deadline when supplied. For incident updates distinguish observed impact, current mitigation, and the next update. Mark missing facts for the author to verify. Return a draft suitable for review.'
  },
  {
    id:'builtin:brand-guidelines:v1', name:'Brand consistency review', source:'Anthropic',
    source_url:'https://github.com/anthropics/skills/blob/main/skills/brand-guidelines/SKILL.md',
    description:'Review a draft or design against brand rules you provide.',
    instructions:'Use the provided brand guide as the standard. Compare the supplied draft or design against relevant guidance on color, typography, visual identity, and tone. Cite the specific rule and the affected content for each finding. Prioritize high-impact inconsistencies and suggest a concrete revision. If no brand guide is supplied, ask for it or clearly distinguish general observations from brand-specific findings.'
  },
  {
    id:'builtin:brainstorming:v1', name:'Product brainstorming', source:'Superpowers',
    source_url:'https://github.com/obra/superpowers/blob/main/skills/brainstorming/SKILL.md',
    description:'Turn an ambiguous feature idea into options and decision criteria.',
    instructions:'Restate the user problem and identify the most important open constraint. For a broad request, ask one targeted question at a time. When enough context exists, propose two or three distinct approaches and compare customer value, effort, and reversibility. Recommend an option with a concrete reason and describe its user flow and success criteria. If the task is one-shot, state assumptions and leave consequential choices visible.'
  },
  {
    id:'builtin:writing-plans:v1', name:'Implementation planning', source:'Superpowers',
    source_url:'https://github.com/obra/superpowers/blob/main/skills/writing-plans/SKILL.md',
    description:'Break an agreed design into changes with checkable outcomes.',
    instructions:'Start with the goal, scope, and dependencies. Break the work into ordered steps small enough to verify individually. For each step specify the affected area, the intended change, and a concrete acceptance check. Use file names only when supported by the supplied context. Include checkpoints for integration and deployment where relevant. Deliver a plan and distinguish proposed checks from checks already run.'
  },
  {
    id:'builtin:web-interface-review:v1', name:'Web interface review', source:'Vercel',
    source_url:'https://github.com/vercel-labs/agent-skills/blob/main/skills/web-design-guidelines/SKILL.md',
    description:'Review supplied UI code or a written walkthrough for usability and accessibility.',
    instructions:'Review the supplied interface evidence for keyboard operation, visible focus, accessible labels, readable contrast, responsive layout, predictable feedback, and loading and error states. Identify the observed location for each finding, explain how it affects the user, and propose a practical fix. Rank repeated issues once. Distinguish what the supplied evidence proves from interactions that would need to be tested in a browser.'
  }
].map(skill => ({...skill, kind:'skill', builtin:true, requires:null}));

export const builtinSkillById = new Map(builtinSkills.map(skill => [skill.id, skill]));
