import { Component, type ReactNode } from 'react';
/** A failed page chunk still leaves navigation and the independent platform entries usable. */
export default class CommunityPageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <div role="alert" className="message error"><p>Unable to load this management page.</p><a href={location.pathname}>Reload page</a><p><a href="/recovery">Open instance recovery</a></p></div> : this.props.children;
  }
}
