export const activeGeneration = (job) => ["queued", "submitting", "generating", "composing"].includes(job.state);
export const generationState = (job) => ({ uploading: "서버에 보관 중", source_changed: "원음·자막이 바뀌어 다시 제작 필요", deleted: "삭제됨", queued: "제작 대기", submitting: "장면 보내는 중", generating: "장면 만드는 중", composing: "원음과 자막을 담는 중", completed: "영상 완성", failed: "제작 실패", canceled: "제작 취소", submission_unknown: "접수 확인 필요 · 다시 생성하지 말고 문의해 주세요" })[job.state] || "상태 확인 중";

// 전송 결과를 못 받은 경우에도 같은 요청을 보관합니다. 새 키로 다시 만들면 중복 비용이 생깁니다.
export class ShortGeneration {
  constructor({ request, code, generation, canRead, pending, savePending }) {
    Object.assign(this, { request, code, generation, canRead, pending, savePending });
    this.abort = new AbortController();
    this.items = []; this.catalog = null; this.plan = null; this.busy = false;
  }
  check() { if (this.abort.signal.aborted || !this.canRead()) throw new Error("여행과 기록 동의를 다시 확인해 주세요."); }
  async call(method, path, body) {
    this.check();
    const value = await this.request(method, path, body, this.abort.signal);
    this.check();
    return value;
  }
  path(suffix) { return `/trips/${this.code}${suffix}`; }
  async load() {
    this.catalog = await this.call("GET", "/short-templates");
    await this.refresh();
  }
  async refresh() {
    const data = await this.call("GET", this.path("/short-assets"));
    if (data.generation !== this.generation) throw new Error("기록 동의가 바뀌었어요.");
    this.items = data.items;
  }
  async preview(templateId, audioReference = false, momentId) {
    if (this.busy || this.pending) throw new Error("먼저 이전 요청의 접수 여부를 확인해 주세요.");
    this.busy = true; this.plan = null;
    try {
      const plan = await this.call("POST", this.path("/short-plans"), { templateId, audioReference, ...(momentId ? { momentId } : {}) });
      if (plan.generation !== this.generation) throw new Error("기록이 바뀌었어요. 쇼츠 화면을 다시 열어 주세요.");
      if (momentId && plan.momentId !== momentId) throw new Error("선택한 장면과 제작 구성이 달라요. 장면을 다시 확인해 주세요.");
      this.plan = plan;
    } finally { this.busy = false; }
  }
  async submit(consent) {
    if (this.busy) return;
    if (!consent) throw new Error("외부 영상 제작에 동의해 주세요.");
    if (!this.catalog?.enabled) throw new Error("AI 영상 제작을 준비하고 있어요. 장면 구성은 미리 확인할 수 있어요.");
    if (!this.pending) {
      if (!this.plan) throw new Error("장면 구성을 먼저 확인해 주세요.");
      const { momentId, templateId, audioReference, generation, planHash } = this.plan;
      const pending = { momentId, templateId, audioReference, generation, planHash, externalGenerationConsent: true, idempotencyKey: crypto.randomUUID() };
      this.savePending(pending); // 저장 실패 시 전송하지 않습니다.
      this.pending = pending;
    }
    this.busy = true;
    try {
      const job = await this.call("POST", this.path("/short-generations"), this.pending);
      this.savePending(null); this.pending = null; this.plan = null;
      this.items = [job, ...this.items.filter((j) => j.id !== job.id)];
      return job;
    } catch (error) {
      if (error.status >= 400 && error.status < 500) {
        this.savePending(null); this.pending = null;
        if ([401, 403, 404, 409, 410].includes(error.status)) this.plan = null;
      }
      throw error;
    } finally { this.busy = false; }
  }
  async cancel(id) {
    await this.call("DELETE", this.path(`/${this.items.find((item) => item.id === id)?.origin === "local-render" ? "short-assets" : "short-generations"}/${encodeURIComponent(id)}`));
    await this.refresh();
  }
  filePath(job) {
    const path = `/api${this.path(`/${job.origin === "local-render" ? "short-assets" : "short-generations"}/${encodeURIComponent(job.id)}/file`)}`;
    if (job.state !== "completed" || job.result?.url !== path) throw new Error("완성된 영상 주소를 확인하지 못했어요.");
    return path;
  }
  close() { this.abort.abort(); this.plan = null; this.items = []; }
}
