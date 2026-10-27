-- Text reference files that ship beside a skill's SKILL.md (plugin skills).
ALTER TABLE "agent_skills" ADD COLUMN "files" JSONB;
