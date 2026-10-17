import { render, screen, waitFor } from '@testing-library/react';
import App from './App';
import api from './api';

// Mock the Axios API
jest.mock('./api');

describe('Search Race Condition', () => {
    it('ignores stale responses when search and page change rapidly', async () => {
        let resolveStaleRequest;
        let resolveFreshRequest;

        // Mock API to return two controlled promises
        api.get
            .mockImplementationOnce(() => new Promise(resolve => { resolveStaleRequest = resolve; }))
            .mockImplementationOnce(() => new Promise(resolve => { resolveFreshRequest = resolve; }));

        render(<App />);

        // 1. Simulate the fast second request resolving FIRST (Page 1 Data)
        resolveFreshRequest({
            data: { products: [{ _id: '1', name: 'Fresh Search Result' }], pages: 1, total: 1 }
        });

        // 2. Simulate the slow first request resolving LAST (Stale Page 3 Data)
        resolveStaleRequest({
            data: { products: [{ _id: '2', name: 'Stale Old Result' }], pages: 1, total: 1 }
        });

        // 3. Verify the UI respects the correct fresh request and ignores the stale one
        await waitFor(() => {
            expect(screen.getByText('Fresh Search Result')).toBeInTheDocument();
        });
        
        expect(screen.queryByText('Stale Old Result')).not.toBeInTheDocument();
    });
});