import { Component, type ReactNode } from 'react';
import CommunityMessage from './CommunityMessage';
/** A failed page chunk still leaves navigation and the independent platform entries usable. */
export default class CommunityPageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <CommunityMessage role="alert" status="danger" title="Unable to load this management page."><a href={location.pathname}>Reload page</a> · <a href="/recovery">Open instance recovery</a></CommunityMessage> : this.props.children;
  }
}
