$(document).ready(function(){

    document.getElementById("find").focus();

	function scroll_to_word(){
		document.getElementsByClassName("selectHighlight")[0].parentNode.scrollIntoView(true)
        window.scrollBy(0,-70)
	}

	//Главный поиск//
	$('#find').bind('keyup change', function(ev){
		var search = $('#find').val();
		$('table').removeHighlight();
		if (search) {
			$('table').highlight(search);
			search_count = $('#table span.highlight').size() - 1;
			count_text = search_count + 1;
			search_number = 0;
			$('#table').selectHighlight(search_number);
			if ( search_count >= 0 ) scroll_to_word();
			$('#b').html('Найдено: <b>'+count_text+'</b>');
		}
		return search_number;
	});

	$('#next').click(function() {
		if (search_number == search_count) return;
		$('#table .selectHighlight').removeClass('selectHighlight');
		search_number++;
		srch_numb = search_number + 1;
		$('#table').selectHighlight(search_number);
		if ( search_count >= 0 ) {
            scroll_to_word();
			$('#count').html('Показано: <b>'+srch_numb+'</b> из '+$('#table span.highlight').size());
		}

	});

	$('#prev').click(function() {
		if (search_number == 0) return;
		$('#table .selectHighlight').removeClass('selectHighlight');
		search_number--;
		srch_numb = search_number + 1;
		$('#table').selectHighlight(search_number);
		if ( search_count >= 0 ) {
			scroll_to_word();
			$('#count').html('Показано: <b>'+srch_numb+'</b> из '+$('#table span.highlight').size());
		}
	});

});

/*
jQuery(document).ready(function(){

	var search_number = 0;
	var search_count = 0;
	var count_text = 0;
	var srch_numb = 0;

	function scroll_to_word(){
		var pos = $('#text .selectHighlight').position();
		jQuery.scrollTo(".selectHighlight", 500, {offset:-150});
	}

	$('#search_text').bind('keyup oncnange', function() {
		$('#text').removeHighlight();
		txt = $('#search_text').val();
		if (txt == '') return;
		$('#text').highlight(txt);
		search_count = $('#text span.highlight').size() - 1;
		count_text = search_count + 1;
		search_number = 0;
		$('#text').selectHighlight(search_number);
		if ( search_count >= 0 ) scroll_to_word();
		$('#count').html('Найдено: <b>'+count_text+'</b>');
	});

	$('#clear_button').click(function() {
		$('#text').removeHighlight();
		$('#search_text').val('поиск');
		$('#count').html('');
		jQuery.scrollTo(0, 500, {queue:true});
	});

	$('#prev_search').click(function() {
		if (search_number == 0) return;
		$('#text .selectHighlight').removeClass('selectHighlight');
		search_number--;
		srch_numb = search_number + 1;
		$('#text').selectHighlight(search_number);
		if ( search_count >= 0 ) {
			scroll_to_word();
			$('#count').html('Показано: <b>'+srch_numb+'</b> из '+$('#text span.highlight').size());
		}
	});

	$('#next_search').click(function() {
		if (search_number == search_count) return;
		$('#text .selectHighlight').removeClass('selectHighlight');
		search_number++;
		srch_numb = search_number + 1;
		$('#text').selectHighlight(search_number);
		if ( search_count >= 0 ) {
			scroll_to_word();
			$('#count').html('Показано: <b>'+srch_numb+'</b> из '+$('#text span.highlight').size());
		}
	});

});


//Главный поиск//
	$('#find').bind('keyup change', function(ev){
		var search = $('#find').val();
		$('body').removeHighlight();
		if (search) {
			$('body').highlight(search);
		}
	});

*/
