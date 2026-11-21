// Một màn hình bị lỗi không làm trắng cả app: hiện thông báo + nút tải lại / báo sự cố, ghi lỗi để gửi kèm.
import { Component, type ReactNode } from 'react';
import { noteError } from '../lib/support';

interface Props { name: string; onReport: (text: string) => void; children: ReactNode }

export class ScreenGuard extends Component<Props, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { noteError(`Màn hình ${this.props.name}`, error); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="card screen-error" role="alert">
        <b>Màn hình {this.props.name} đang bị lỗi.</b>
        <button type="button" className="btn primary" onClick={() => window.location.reload()}>Tải lại</button>
        <button type="button" className="btn" onClick={() => this.props.onReport(`Màn hình ${this.props.name} bị lỗi, không mở được.`)}>Báo sự cố</button>
      </div>
    );
  }
}
