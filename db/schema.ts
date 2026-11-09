import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const learnerStates = sqliteTable("learner_states", {
  userId: text("user_id").primaryKey(),
  revision: integer("revision").notNull(),
  state: text("state", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
});

export const teacherLessons = sqliteTable("teacher_lessons", {
  userId: text("user_id").notNull(),
  day: integer("day").notNull(),
  lesson: text("lesson", { mode: "json" }).$type<import("@/app/curriculum").Lesson>().notNull(),
}, table => [primaryKey({ columns: [table.userId, table.day] })]);

export const teacherFeedback = sqliteTable("teacher_feedback", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  day: integer("day").notNull(),
  stage: text("stage").notNull(),
  attempt: text("attempt").notNull(),
  evidence: text("evidence").notNull(),
  feedback: text("feedback").notNull(),
  pronunciation:text("pronunciation",{mode:"json"}).$type<{
    band:number;recordingId:string;reviewedWholeClip:true;observation:string;scope:"partial"
  }>(),
  createdAt: text("created_at").notNull(),
}, table => [index("teacher_feedback_user_day").on(table.userId, table.day)]);

export const reviewJobs = sqliteTable("review_jobs", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  day: integer("day").notNull(),
  submissionKey: text("submission_key").notNull(),
  requestHash: text("request_hash").notNull(),
  revision: integer("revision").notNull(),
  snapshot: text("snapshot", {mode:"json"}).$type<import("@/lib/review-jobs").FrozenReview>().notNull(),
  createdAt: text("created_at").notNull(),
}, table => [
  uniqueIndex("review_jobs_submission").on(table.userId, table.submissionKey),
  index("review_jobs_user_day").on(table.userId, table.day),
]);
