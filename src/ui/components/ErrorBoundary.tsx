import React from "react";
import { useTranslation } from "../i18n";

function ErrorFallback({ error, onReset }: { error: Error | null; onReset: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="max-w-2xl mx-auto mt-20 p-6 bg-red-900/30 border border-red-700 rounded-xl text-center">
      <h2 className="text-xl font-bold text-red-400 mb-2">{t("common.somethingWrong")}</h2>
      <p className="text-sm text-gray-300 mb-4">{error?.message}</p>
      <button className="px-4 py-2 bg-red-700 hover:bg-red-600 rounded cursor-pointer text-sm" onClick={onReset}>{t("common.tryAgain")}</button>
    </div>
  );
}

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
      return <ErrorFallback error={this.state.error} onReset={() => this.setState({ hasError: false, error: null })} />;
    }
    return this.props.children;
  }
}
