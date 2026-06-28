import React from 'react';

export const ProductSkeleton = () => (
    <div className="bg-secondary-bg/50 border border-border-color rounded-2xl p-4 animate-pulse">
        <div className="w-full aspect-square bg-border-color/50 rounded-xl mb-4" />
        <div className="h-4 bg-border-color/50 rounded w-3/4 mb-2" />
        <div className="h-3 bg-border-color/50 rounded w-1/2 mb-4" />
        <div className="h-5 bg-border-color/50 rounded w-1/4" />
    </div>
);