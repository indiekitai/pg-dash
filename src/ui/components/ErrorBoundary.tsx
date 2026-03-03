import React from "react";

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="max-w-2xl mx-auto mt-20 p-6 bg-red-900/30 border border-red-700 rounded-xl text-center">
          <h2 className="text-xl font-bold text-red-400 mb-2">Something went wrong</h2>
          <p className="text-sm text-gray-300 mb-4">{this.state.error?.message}</p>
          <button className="px-4 py-2 bg-red-700 hover:bg-red-600 rounded cursor-pointer text-sm" onClick={() => this.setState({ hasError: false, error: null })}>Try Again</button>
        </div>
      );
    }
    return this.props.children;
  }
}
