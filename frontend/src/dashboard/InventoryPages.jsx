export default function InventoryPages({ page, pages, setPage }) {
    if (pages < 2) return null;
    return <nav aria-label="Inventory pages" className="flex justify-center items-center gap-4 my-4">
        <button disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span>Page {page} of {pages}</span>
        <button disabled={page === pages} onClick={() => setPage(page + 1)}>Next</button>
    </nav>;
}
