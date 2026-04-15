export class UIView {
  constructor(container) {
    this.container = container;
  }

  showLoading() {
    this.container.textContent = 'Loading...';
  }

  hideLoading() {
    this.container.textContent = '';
  }
}
