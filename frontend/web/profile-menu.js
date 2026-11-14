// 오른쪽 위 내 얼굴 단추와 프로필 드롭다운. 시안의 차 프레임 C17m(2206:5852 프로필 드롭다운)과
// 로그아웃 확인(2220:5864)을 폰 밝은 톤으로 옮긴 것(docs/design.md §5 '내 얼굴 단추와 드롭다운').
import { h } from "./shared.js";
import { groupFaces } from "./groups.js";

// 로그아웃: 이 폰이 기억하는 신원(프로필 토큰, 여행마다의 참가자 id·토큰·물음 표시)을 접두어로 모두 지운다.
// ponytail: 서버의 토큰은 그대로 둔다 — 로그아웃 API가 없다(docs/api/accounts.md). 생기면 onLogout에서 먼저 부른다.
export function forgetIdentity(storage, prefix) {
  for (let i = storage.length - 1; i >= 0; i--) {
    const key = storage.key(i);
    if (key?.startsWith(prefix)) storage.removeItem(key);
  }
}

// 드롭다운의 '현재 동승 그룹': 가족이 먼저, 없으면 첫 그룹.
export const currentGroup = (groups) => groups?.find((g) => g.kind === "family") ?? groups?.[0] ?? null;

const icon = (d) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
};
const GALLERY = "M4 5h16v14H4V5Zm4 4h.01M4 16l5-5 4 4 2-2 5 5";
const LOGOUT = "M10 4H5v16h5m5-12 4 4-4 4m4-4H9";
const PERSON = "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0";

export function createProfileMenu({ getProfile, signedIn = () => false, face, loadGroups, onProfile, onSignIn, onGroups, onSeats, onGallery, onLogout }) {
  let dialog = null;
  const close = () => {
    dialog?.close();
    dialog?.remove();
    dialog = null;
  };
  // 바깥(어둡게 한 곳)을 누르거나 Esc면 닫는다. 판은 dialog 안의 한 칸이라 판을 누른 것은 dialog 자신이 아니다.
  const overlay = (className, label, ...kids) => {
    close();
    dialog = h("dialog", { className: `menu-dialog ${className}`, "aria-label": label, onclick: (e) => e.target === dialog && close(), oncancel: (e) => (e.preventDefault(), close()) }, ...kids);
    document.body.append(dialog);
    dialog.showModal();
  };
  const go = (fn) => () => (close(), fn());
  const row = (label, onclick, d) => h("button", { type: "button", className: "menu-row", onclick: go(onclick) },
    d && h("span", { className: "menu-icon" }, icon(d)), h("span", { className: "menu-label" }, label), h("span", { className: "menu-arrow", "aria-hidden": "true" }, "›"));

  function groupCard(g) {
    if (!g) return h("div", { className: "menu-group empty" }, h("small", {}, "현재 동승 그룹"), h("strong", {}, "아직 동승 그룹이 없어요"));
    return h("div", { className: "menu-group" }, groupFaces(g),
      h("div", {}, h("small", {}, "현재 동승 그룹"), h("p", {}, h("strong", {}, g.name), h("span", { className: "menu-count", "aria-label": `${g.members.length}명` }, icon(PERSON), String(g.members.length)))));
  }

  async function open() {
    const me = getProfile();
    // 로그인 전·프로필 없는 손님: 기본 얼굴 → 로그인·계정 만들기(P02). 계정은 있는데 프로필을 읽는 중·못 읽음이면 내 프로필(#me)로.
    if (!me) return signedIn() ? onProfile() : onSignIn();
    const slot = h("div", { className: "menu-group loading" }, h("small", {}, "현재 동승 그룹"), h("strong", {}, "불러오는 중"));
    overlay("profile-menu", "내 프로필 메뉴", h("div", { className: "menu-panel" },
      h("div", { className: "menu-head" }, face(), h("strong", {}, me.name), h("button", { type: "button", className: "menu-close", "aria-label": "닫기", onclick: close }, "✕")),
      slot,
      row("내 프로필", onProfile),
      row("동승 그룹 변경", onGroups),
      row("좌석 배정", onSeats),
      row("갤러리 바로가기", onGallery, GALLERY),
      h("button", { type: "button", className: "menu-logout", onclick: confirmLogout }, h("span", { className: "menu-icon" }, icon(LOGOUT)), "로그아웃"),
    ));
    const opened = dialog;
    const groups = await loadGroups().catch(() => undefined);
    if (dialog !== opened) return; // 그새 닫았거나 다른 창으로 바뀜
    slot.replaceWith(groups === undefined ? h("div", { className: "menu-group empty" }, h("small", {}, "현재 동승 그룹"), h("strong", {}, "불러오지 못했어요")) : groupCard(currentGroup(groups)));
  }

  function confirmLogout() {
    overlay("logout-confirm", "로그아웃 확인", h("div", { className: "menu-panel confirm" },
      h("h2", {}, "로그아웃할까요?"),
      h("p", {}, "로그아웃하면 시작 화면으로 돌아가요."),
      h("div", { className: "confirm-actions" },
        h("button", { type: "button", className: "confirm-cancel", onclick: close }, "취소"),
        h("button", { type: "button", className: "menu-logout", onclick: go(onLogout) }, "로그아웃"))));
  }

  return {
    // 머리 줄 오른쪽 끝의 내 얼굴. 모든 화면에 늘 있다(11/15 오너 "예외는 없어"). 프로필이 없으면 빈 원형 + 기본 캐릭터이고 누르면 P02.
    button: () => getProfile() || signedIn()
      ? h("button", { type: "button", className: "me-button", "aria-label": "내 프로필 메뉴 열기", "aria-haspopup": "dialog", onclick: open }, face())
      : h("button", { type: "button", className: "me-button is-guest", "aria-label": "로그인·계정 만들기", onclick: open }, face()),
    open,
    close,
    confirmLogout,
  };
}
