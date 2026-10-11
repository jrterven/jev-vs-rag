/** Public annotation contracts. Provider names and raw experiment IDs never enter TaskView. */
export interface Participant { id: string; name: string; role: 'coordinator' | 'collaborator'; canAdjudicate: boolean; active: boolean }
export type AnnotationMode = 'independent_review' | 'single_annotator';
/** Missing mode on historical projects means independent_review. */
export interface Project { id: string; name: string; createdAt: string; annotationMode?: AnnotationMode; soleAnnotatorId?: string }
export interface TextBlock { id: string; index: number; text: string; start: number; end: number; heading?: string; page?: number }
export interface DocumentInfo { id: string; projectId: string; title: string; hash: string; version: number; blockCount: number; sourceUrl?: string; attribution?: { text: string; url: string; license: string; licenseUrl: string; notice?: string }; sections: Array<{ blockIndex: number; title: string }> }
/** start/end are document-global UTF-16 offsets, end exclusive. */
export interface EvidenceSpan { blockId: string; start: number; end: number; quote: string }
export type QuestionType = 'factual' | 'explanatory' | 'multi_section';
export interface AnswerRating { correctness: 0 | 1 | 2 | null; unsupported: 'yes' | 'no' | 'uncertain'; citations: 'supported' | 'partial' | 'unsupported' | 'not_applicable'; abstention: 'justified' | 'unjustified' | 'not_applicable'; comment: string; issue: string }
export interface AnnotationDraft { question: string; questionType: QuestionType; answer: string; evidenceSets: EvidenceSpan[][]; unanswerable?: boolean; rating?: AnswerRating; note?: string }
export interface Task { id: string; projectId: string; documentId: string; assigneeId: string; kind: 'author' | 'review' | 'adjudicate' | 'evaluate'; status: 'assigned' | 'draft' | 'submitted' | 'completed'; revision: number; title: string; createdAt: string; sourceTaskId?: string; assignedQuestionType?: QuestionType; projectName?: string; documentTitle?: string }
export interface AnonymousAnswer { text: string; citations: Array<{ label: string; spans: EvidenceSpan[] }> }
export interface TaskView { task: Task; document: DocumentInfo; draft: AnnotationDraft | null; annotationMode: AnnotationMode; selfReview?: { reviewedAt: string; revision: number }; question?: string; questionType?: QuestionType; reference?: { answer: string; evidenceSets: EvidenceSpan[][] }; answer?: AnonymousAnswer; comparison?: { original: AnnotationDraft; independent: AnnotationDraft; verdict?: 'agree' | 'disagree'; note?: string }; adjudication?: Array<{ label: string; annotation: AnnotationDraft }> }
export interface HumanAnnotationProvenance { mode: AnnotationMode; annotatorIds: string[]; reviewedAt: string }
/** Research-only model authorship; it is never a human review or a project mode. */
export interface ModelGeneratedAnnotationProvenance {
  mode: 'model_generated'; model: string; reasoningEffort: string; authoringRunId: string;
  promptHash: string; documentHash: string; sourceLockHash: string; generatedAt: string; humanReviewed: false;
  validation: { mode: 'model_self_check' | 'model_review'; model: string; reasoningEffort: string; promptHash: string; reportHash: string; validatedAt: string; status: 'passed' };
  annotatorIds?: never; reviewedAt?: never;
}
export interface FrozenQuestion { id: string; documentId: string; question: string; questionType?: QuestionType; answer: string; evidenceSets: EvidenceSpan[][]; unanswerable?: boolean; annotation?: HumanAnnotationProvenance | ModelGeneratedAnnotationProvenance }
export interface FrozenDataset { schemaVersion: 1; id: string; projectId: string; version: number; createdAt: string; hash: string; documents: Array<DocumentInfo & { blocks: TextBlock[] }>; questions: FrozenQuestion[] }
export interface AdminOverview { participants: Participant[]; projects: Project[]; documents: DocumentInfo[]; tasks: Task[]; freezes: Array<{ id: string; projectId: string; version: number; hash: string; createdAt: string }>; issues?: Array<{ taskId: string; issue: string }> }
