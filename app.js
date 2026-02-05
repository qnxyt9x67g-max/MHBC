// Navigation
function showSection(sectionId) {
    document.querySelectorAll('section').forEach(sec => {
        sec.classList.remove('active');
    });
    document.getElementById(sectionId).classList.add('active');
}

// Data structure for videos
// Note: Automatic fetching from YouTube requires API keys, which are not used here to avoid paid services or backend.
// Manually paste video details here. Use YouTube embed URLs or video IDs.
// Example: For a video https://www.youtube.com/watch?v=VIDEO_ID, embed is https://www.youtube.com/embed/VIDEO_ID

const sundayVideos = [
    { title: 'Recent Sunday Service', url: 'https://www.youtube.com/embed/jzHaWseMX30' },
    { title: 'Previous Sunday Service', url: 'https://www.youtube.com/embed/OhkuBvoPX8A' },
    // Add more: { title: 'Title', url: 'https://www.youtube.com/embed/VIDEO_ID' },
];

const wednesdayVideos = [
    // No specific Wednesday videos found; add manually if available
    // { title: 'Wednesday Service', url: 'https://www.youtube.com/embed/VIDEO_ID' },
];

// Render videos
function renderVideos(containerId, videos) {
    const container = document.getElementById(containerId);
    videos.forEach(video => {
        const div = document.createElement('div');
        div.classList.add('video-item');
        div.innerHTML = `
            <h3>${video.title}</h3>
            <iframe src="${video.url}" frameborder="0" allowfullscreen></iframe>
        `;
        container.appendChild(div);
    });
}

document.addEventListener('DOMContentLoaded', () => {
    showSection('home');
    renderVideos('sunday-videos', sundayVideos);
    renderVideos('wednesday-videos', wednesdayVideos);
});

// For PWA: Register service worker if needed, but omitted as no backend
// If you want offline, add a service-worker.js and register here.
// Add this after your existing code

document.addEventListener('DOMContentLoaded', () => {
    // ... your existing code (showSection home, render videos) ...

    // Close all submenus when clicking/tapping anywhere outside
    document.addEventListener('click', function(e) {
        if (!e.target.closest('.has-submenu')) {
            document.querySelectorAll('.has-submenu').forEach(item => {
                item.classList.remove('open');
            });
        }
    });

    // Toggle submenus on tap/click
    document.querySelectorAll('.menu-toggle').forEach(toggle => {
        toggle.addEventListener('click', function(e) {
            e.preventDefault();          // prevent any default behavior
            e.stopPropagation();         // stop bubbling so document click doesn't close it immediately

            const parentLi = this.closest('.has-submenu');
            const isOpen = parentLi.classList.contains('open');

            // Close all other submenus first
            document.querySelectorAll('.has-submenu').forEach(item => {
                item.classList.remove('open');
            });

            // Toggle the clicked one
            if (!isOpen) {
                parentLi.classList.add('open');
            }
        });
    });
});
