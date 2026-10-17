export const optimizeImage = (url) => {
    if (!url) return '';
    // If it's a placeholder or external image, just return it
    if (!url.includes('cloudinary.com')) return url; 

    // Cloudinary URLs structure: .../image/upload/v1234567890/...
    // We want to inject the parameters right after /upload/
    const uploadSegment = '/upload/';
    const uploadIndex = url.indexOf(uploadSegment);
    
    if (uploadIndex !== -1) {
        const before = url.substring(0, uploadIndex + uploadSegment.length);
        const after = url.substring(uploadIndex + uploadSegment.length);
        return `${before}q_auto,f_auto/${after}`;
    }
    
    return url;
};