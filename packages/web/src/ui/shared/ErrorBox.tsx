// Standardized error display: dashed border, "Error" title, smaller message text — reused across
// every page instead of each one rendering ad hoc red text.
export function ErrorBox({ message }: { message: string }) {
    return (
        <div className="error-box">
            <strong className="error-box-title">Error</strong>
            <p className="error-box-message">{message}</p>
        </div>
    );
}
