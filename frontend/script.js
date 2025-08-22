function openTab(evt, tabName) {
  const contents = document.getElementsByClassName("tab-content");
  for (let c of contents) c.classList.remove("active");

  const buttons = document.getElementsByClassName("tab-button");
  for (let b of buttons) b.classList.remove("active");

  document.getElementById(tabName).classList.add("active");
  evt.currentTarget.classList.add("active");
}
